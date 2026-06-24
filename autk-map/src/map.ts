/**
 * @module AutkMap
 * A WebGPU-based map rendering engine for GeoJSON data.
 *
 * This module defines the `AutkMap` class, which serves as the main controller
 * for rendering, interaction, and layer lifecycle management. It provides
 * high-level APIs for loading GeoJSON feature collections and prebuilt meshes,
 * updating thematic mappings and color configurations, and handling user
 * interactions such as picking and highlighting.
 *
 * The `AutkMap` class integrates a WebGPU renderer, a camera system, a layer
 * manager, and event controllers for keyboard, mouse, and resize events. It
 * also exposes a public event bus for map events (e.g., picking) and a UI
 * controller for managing the map's user interface components.
 */

/// <reference types="@webgpu/types" />

import {
    FeatureCollection,
    Geometry,
} from 'geojson';

import {
    Camera,
    ColorMapDomainStrategy,
    ColorMapConfig,
    ColorMap,
    ColorMapInterpolator,
    EventEmitter,
    isNumericLike,
    TriangulatorPoints,
    TriangulatorPolygons,
    TriangulatorPolylines,
    TriangulatorBuildings,
    TriangulatorRaster,
    valueAtPath,
    LayerType,
    ResolvedDomain,
    mapGeometryTypeToLayerType,
} from '@urban-toolkit/autk-core';

import { MapEvent } from './types-events';
import type { MapEventRecord } from './types-events';

import {
    LayerData,
    LayerInfo,
    LayerRenderInfo,
    LayerThematic,
} from './types-layers';

import {
    LoadCollectionParams,
    LoadMeshParams,
    UpdateColorMapParams,
    UpdateRenderInfoParams,
    UpdateRasterParams,
    UpdateThematicParams,
} from './api';

import { KeyEvents } from './events-key';
import { MouseEvents } from './events-mouse';
import { ResizeEvents } from './events-resize';

import { Renderer } from './renderer';

import { Layer } from './layer';
import { LayerManager } from './layer-manager';
import { VectorLayer } from './layer-vector';
import { RasterLayer } from './layer-raster';
import { Triangles3DLayer } from './layer-triangles3D';
import { SpriteLayer } from './layer-sprite';
import { PipelineBuildingSSAO } from './pipeline-triangle-ssao';

import { AutkMapUi } from './map-ui';
import { TerrainRenderer } from './terrain-renderer';
import type { TerrainDebugOptions } from './terrain-renderer';
import { terrainSourceFromRaster } from './terrain-source';
import type { TerrainSource } from './terrain-source';

const clampNumber = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Main map controller for rendering, interaction, and layer lifecycle.
 *
 * `AutkMap` initializes the renderer, camera, layer manager, and interaction
 * controllers, and exposes high-level APIs for loading and updating layers.
 * 
 * @example
 * const canvas = document.getElementById('map-canvas') as HTMLCanvasElement;
 *
 * const map = new AutkMap(canvas);
 * await map.init();
 * 
 * const geojsonData = { \/* GeoJSON data *\/ };
 * map.loadCollection('my_data', { collection: geojsonData });
 */
export class AutkMap {
    /** View and projection camera. */
    protected _camera!: Camera;
    /** WebGPU renderer. */
    protected _renderer!: Renderer;
    /** Manages the ordered layer stack. */
    protected _layerManager!: LayerManager;

    /** Keyboard interaction handler. */
    protected _keyEvents!: KeyEvents;
    /** Mouse interaction handler. */
    protected _mouseEvents!: MouseEvents;
    /** Canvas resize handler. */
    protected _resizeEvents!: ResizeEvents;
    /** Public event bus for map events. */
    protected _mapEvents!: EventEmitter<MapEventRecord>;

    /** Map UI controller. */
    protected _ui!: AutkMapUi;
    /** Backing WebGPU canvas. */
    protected _canvas!: HTMLCanvasElement;
    /** Active requestAnimationFrame id, if draw loop is running. */
    protected _animationFrameId: number | null = null;
    /** Indicates whether this map instance has been destroyed. */
    protected _isDestroyed: boolean = false;
    /** Set after the first render-loop error to deduplicate repeated frame failures. */
    protected _renderErrorLogged: boolean = false;
    private _terrainRenderer: TerrainRenderer | null = null;
    private _terrainSource: TerrainSource | null = null;
    private readonly _terrainOverlayCamera: Camera = new Camera();
    private _terrainDebug: Required<TerrainDebugOptions> = {
        showMesh: false,
        enableCulling: true,
        freezeLod: false,
    };

    /**
     * Creates an AutkMap instance bound to a canvas element.
     *
     * @param canvas Canvas element used as the WebGPU drawing surface.
     * @throws Never throws.
     */
    constructor(canvas: HTMLCanvasElement) {
        this._canvas = canvas;
        this._renderer = new Renderer(canvas);

        this._camera = new Camera();
        this._layerManager = new LayerManager();

        this._keyEvents = new KeyEvents(this);
        this._mouseEvents = new MouseEvents(this);
        this._resizeEvents = new ResizeEvents(this);
        this._mapEvents = new EventEmitter<MapEventRecord>();

        this._ui = new AutkMapUi(this);
    }

    /** View and projection camera. */
    get camera(): Camera {
        return this._camera;
    }

    /** WebGPU renderer. */
    get renderer(): Renderer {
        return this._renderer;
    }

    /** Ordered layer stack manager. */
    get layerManager(): LayerManager {
        return this._layerManager;
    }

    /** Backing WebGPU canvas element. */
    get canvas(): HTMLCanvasElement {
        return this._canvas;
    }

    /** Map UI controller. */
    get ui(): AutkMapUi {
        return this._ui;
    }

    /** Public typed map-event bus (e.g., picking). */
    get events(): EventEmitter<MapEventRecord> {
        return this._mapEvents;
    }

    /** Currently active pick-enabled layer, if any. */
    get activePickingLayer(): Layer | null {
        return this._layerManager.layers.find((layer) => layer.layerRenderInfo.isPick) ?? null;
    }

    /**
     * Initializes renderer resources, event bindings, and UI.
     *
     * @returns Promise that resolves when renderer initialization completes.
     * @throws If WebGPU is not available or device acquisition fails.
     * @example
     * await map.init();
     */
    async init() {
        if (this._isDestroyed) {
            return;
        }

        await this._renderer.init();

        this._keyEvents.bindEvents();
        this._mouseEvents.bindEvents();

        this._resizeEvents.bindEvents();
        this._resizeEvents.resize();

        this.render();

        this._ui.buildUi();
    }

    /**
     * Loads a GeoJSON feature collection as a map layer.
     *
     * When `type` is omitted the layer type is inferred from all non-null
     * geometries in the collection. Implicit inference only works for
     * collections that resolve to a single geometry family
     * (Point → 'points', LineString → 'polylines', Polygon → 'polygons').
     * Mixed-geometry collections must pass an explicit `type`.
     *
     * Supported layer types: 'surface', 'water', 'parks', 'roads', 'buildings',
     * 'points', 'polylines', 'polygons', 'raster'.
     *
     * @param id Unique layer identifier.
     * @param params Load parameters.
     * @param params.collection Source GeoJSON feature collection.
     * @param params.type Optional layer type override.
     * @param params.loadConfig Optional geometry-building configuration applied while loading.
     * @param params.property Optional value extractor applied immediately as the initial thematic mapping.
     * @throws Never throws. Errors are logged to the console.
     */
    loadCollection(id: string, { collection, type = null, property, loadConfig }: LoadCollectionParams): void {
        if (!this.layerManager.hasOrigin) {
            this.layerManager.initializeOrigin(collection);
        }

        let sType = type ?? this.inferCollectionLayerType(collection, id);
        if (!sType) { return; }

        switch (sType) {
            case 'surface':
            case 'water':
            case 'parks':
            case 'polygons':
                this.createPolygonsLayer(id, collection as FeatureCollection, sType, typeof property === 'string' ? property : undefined);
                break;

            case 'roads':
            case 'polylines': {
                this.createPolylinesLayer(
                    id,
                    collection as FeatureCollection,
                    sType,
                    typeof property === 'string' ? property : undefined,
                    loadConfig?.polylinesWidth,
                );
                break;
            }
            case 'points':
                this.createPointsLayer(id, collection as FeatureCollection, sType, typeof property === 'string' ? property : undefined);
                break;

            case 'buildings':
                this.createBuildingsLayer(
                    id,
                    collection as FeatureCollection,
                    sType,
                    typeof property === 'string' ? property : undefined,
                    loadConfig?.buildingsZeroHeight,
                );
                break;

            case 'raster':
                if (typeof property !== 'string') { console.error(`Layer "${id}": property path string is required for raster layers.`); return; }
                this.createRasterLayer(id, collection, property);
                break;

            default:
                console.error(`Collection of layer ${id} has an unknown layer type: ${sType}.`);
                break;
        }

        this._ui.refreshLayerList();
    }

    /**
     * Loads a prebuilt 3D triangle mesh directly into the map.
     *
     * Mesh coordinates must already be expressed in the map's local coordinate
     * space, relative to the current shared origin.
     *
     * @param id Layer identifier.
     * @param params Mesh loading parameters.
     * @param params.geometry Prebuilt mesh geometry chunks.
     * @param params.components Per-feature mesh component metadata.
     * @param params.thematic Optional precomputed thematic values.
     * @param params.type Optional layer type override for the mesh.
     * @returns Nothing. The mesh layer is created and registered with the map.
     * @throws If the map origin has not been initialized.
     */
    loadMesh(id: string, { geometry, components, thematic, type = 'buildings' }: LoadMeshParams): void {
        if (!this.layerManager.hasOrigin) {
            throw new Error(`Layer '${id}': map origin must be initialized before loading a mesh.`);
        }

        const layerInfo: LayerInfo = {
            id,
            zIndex: this._layerManager.computeZindex(type),
            typeLayer: type,
        };
        const layerRenderInfo: LayerRenderInfo = {
            opacity: 1.0,
            colormap: { config: this.defaultColorMap() },
            isColorMap: false,
            isPick: false,
            isSkip: false,
        };
        const layerData: LayerData = {
            geometry,
            components,
            thematic: thematic ?? components.map(() => ({ value: 0, valid: 1 })),
        };

        this.createLayer(layerInfo, layerRenderInfo, layerData);
        this._ui.refreshLayerList();
    }

    /**
     * Updates the thematic (color-mapped) values of a layer from a feature collection.
     *
     * Normalization to `[0, 1]` (required by the GPU shader) and legend label
     * generation are delegated to `ColorMap` based on the active layer
     * `colorMap` configuration.
     *
     * Thematic values are aligned to rendered components through source feature
     * metadata captured during triangulation. When both the layer and the input
     * collection expose feature ids, matching is done by `feature.id`; otherwise
     * the update falls back to the original feature index order.
     *
     * For raster layers the raster texture is rebuilt from `property`.
     *
     * @param id Layer identifier.
     * @param params Update parameters.
     * @param params.collection Source feature collection.
     * @param params.property Dot-path accessor resolved from each feature.
     * @throws Never throws. Errors are logged to the console.
     */
    updateThematic(id: string, { collection, property }: UpdateThematicParams): void {
        const layer = this._layerManager.searchByLayerId(id) as VectorLayer | SpriteLayer | null;

        if (!layer) { return; }
        if (layer.layerInfo.typeLayer === 'raster') { return; };

        const features = collection.features;
        if (features.length === 0) { return; }

        const components = layer.components;
        if (components.length === 0) { return; }

        const propertyResolver = (item: unknown) => valueAtPath(item, property);
        const sample = features
            .map(f => propertyResolver(f))
            .find(v => v !== undefined && v !== null);

        if (sample === undefined || sample === null) {
            console.warn(`Thematic property not found on layer '${id}': ${property}`);
            this.updateRenderInfo(id, { renderInfo: { isColorMap: false } });
            return;
        }

        const dataType = isNumericLike(sample) ? 'number' : typeof sample;
        if (dataType !== 'number' && dataType !== 'string') {
            console.warn(`Unsupported thematic property type on layer '${id}': ${dataType}`);
            this.updateRenderInfo(id, { renderInfo: { isColorMap: false } });
            return;
        }

        let resolvedDomain: ResolvedDomain = [];

        const colorMap = layer.layerRenderInfo.colormap.config;
        const thematicByFeatureIndex: LayerThematic[] = [];
        const canMatchById = components.every((component) => component.featureId !== undefined)
            && features.every((feature) => feature.id !== undefined);
        const thematicByFeatureId = canMatchById ? new Map<string | number, LayerThematic>() : null;

        const storeThematicValue = (featureIndex: number, value: number, valid: number): boolean => {
            const thematic = { value, valid };
            thematicByFeatureIndex[featureIndex] = thematic;

            if (!thematicByFeatureId) {
                return true;
            }

            const featureId = features[featureIndex].id as string | number;
            if (thematicByFeatureId.has(featureId)) {
                console.error(`Layer '${id}': duplicate feature id '${featureId}' prevents thematic matching.`);
                return false;
            }

            thematicByFeatureId.set(featureId, thematic);
            return true;
        };

        if (dataType === 'number') {
            const rawValues = features.map((feature) => {
                const resolved = propertyResolver(feature);
                const numeric = Number(resolved);
                return Number.isFinite(numeric) ? numeric : undefined;
            });
            const validValues = rawValues.filter((value): value is number => value !== undefined);

            if (validValues.length === 0) {
                console.warn(`No valid numeric thematic values found on layer '${id}': ${property}`);
                this.updateRenderInfo(id, { renderInfo: { isColorMap: false } });
                return;
            }

            resolvedDomain = ColorMap.resolveDomainFromData(validValues, colorMap);
            for (let featureIndex = 0; featureIndex < rawValues.length; featureIndex++) {
                const rawValue = rawValues[featureIndex];
                if (!storeThematicValue(featureIndex, rawValue ?? 0, rawValue === undefined ? 0 : 1)) {
                    return;
                }
            }
        } 
        else if (dataType === 'string') {
            const rawValues = features.map((feature) => {
                const resolved = propertyResolver(feature);
                return resolved === undefined || resolved === null ? undefined : String(resolved);
            });
            const validValues = rawValues.filter((value): value is string => value !== undefined);

            if (validValues.length === 0) {
                console.warn(`No valid categorical thematic values found on layer '${id}': ${property}`);
                this.updateRenderInfo(id, { renderInfo: { isColorMap: false } });
                return;
            }

            const categoricalDomain = ColorMap.resolveDomainFromData(validValues, colorMap) as string[];
            resolvedDomain = categoricalDomain;
            for (let featureIndex = 0; featureIndex < rawValues.length; featureIndex++) {
                const rawValue = rawValues[featureIndex];
                const categoryIndex = rawValue === undefined ? 0 : categoricalDomain.indexOf(rawValue);
                const isValid = rawValue !== undefined && categoryIndex >= 0 ? 1 : 0;
                if (!storeThematicValue(featureIndex, categoryIndex >= 0 ? categoryIndex : 0, isValid)) {
                    return;
                }
            }
        }

        const thematicData: LayerThematic[] = [];
        if (thematicByFeatureId) {
            for (const component of components) {
                const thematic = thematicByFeatureId.get(component.featureId as string | number);
                if (!thematic) {
                    console.error(
                        `Layer '${id}': missing thematic value for feature id '${String(component.featureId)}'.`
                    );
                    return;
                }
                thematicData.push(thematic);
            }
        } else {
            for (const component of components) {
                const thematic = thematicByFeatureIndex[component.featureIndex];
                if (!thematic) {
                    console.error(
                        `Layer '${id}': missing thematic value for source feature index ${component.featureIndex}.`
                    );
                    return;
                }
                thematicData.push(thematic);
            }
        }

        if (!layer.loadThematic(thematicData)) {
            return;
        }

        layer.updateLayerRenderInfo({
            colormap: {
                ...layer.layerRenderInfo.colormap,
                computedDomain: resolvedDomain,
                computedLabels: ColorMap.computeLabels(resolvedDomain),
            },
        });
        this._ui.refreshLegend(layer);

        layer.makeLayerDataDirty();
    }

    /**
     * Updates raster layer values and color domain.
     *
     * @param id Layer identifier.
     * @param params Update parameters.
     * @param params.collection GeoTIFF-derived feature collection.
     * @param params.property Dot-path accessor for a flat raster band array on feature properties.
     * @param params.transferFunction Optional opacity transfer-function configuration.
     * @throws Never throws. Errors are logged to the console.
     */
    updateRaster(id: string, { collection, property, transferFunction }: UpdateRasterParams): void {
        const layer = this._layerManager.searchByLayerId(id);
        if (!layer || layer.layerInfo.typeLayer !== 'raster') { return; }

        if (collection.features.length === 0) {
            console.warn(`Raster update skipped for layer '${id}': empty collection.`);
            return;
        }

        const props = collection.features[0].properties;
        if (!props) {
            console.warn(`Raster update skipped for layer '${id}': invalid raster payload.`);
            return;
        }

        const resolved = valueAtPath(props, property);
        const rasterValues = resolved instanceof Float32Array
            ? resolved
            : ArrayBuffer.isView(resolved) && !(resolved instanceof DataView)
                ? new Float32Array(Array.from(resolved as unknown as ArrayLike<number>, (value: number) => {
                    const numeric = Number(value);
                    return Number.isFinite(numeric) ? numeric : Number.NaN;
                }))
                : Array.isArray(resolved)
                    ? new Float32Array(resolved.map((value: unknown) => {
                        const numeric = Number(value);
                        return Number.isFinite(numeric) ? numeric : Number.NaN;
                    }))
                    : null;

        if (!rasterValues || rasterValues.length === 0) {
            console.warn(`Raster update skipped for layer '${id}': invalid raster band '${property}'.`);
            return;
        }

        const rasterLayer = layer as RasterLayer;
        const config = layer.layerRenderInfo.colormap.config;
        const resolvedDomain = ColorMap.resolveDomainFromData(rasterValues, config);

        layer.updateLayerRenderInfo({
            colormap: {
                ...layer.layerRenderInfo.colormap,
                computedDomain: resolvedDomain,
                computedLabels: ColorMap.computeLabels(resolvedDomain),
            },
        });
        this._ui.refreshLegend(layer);

        if (transferFunction) {
            rasterLayer.setTransferFunction(transferFunction);
        }

        rasterLayer.loadRaster(rasterValues);
        rasterLayer.makeLayerDataDirty();
    }

    /**
     * Updates color-map configuration for a layer.
     *
     * @param id Layer identifier.
     * @param params Color-map update parameters.
     * @returns Nothing. The target layer render configuration is updated in place.
     * @throws Never throws. Unknown layers are silently ignored.
     */
    updateColorMap(id: string, { colorMap }: UpdateColorMapParams): void {
        const layer = this._layerManager.searchByLayerId(id);
        if (!layer) { return; }

        const currentConfig = layer.layerRenderInfo.colormap.config;

        const mergedColorMap: ColorMapConfig = {
            interpolator: colorMap.interpolator ?? currentConfig.interpolator ?? ColorMapInterpolator.SEQ_BLUES,
            domainSpec: colorMap.domainSpec ?? currentConfig.domainSpec ?? { type: ColorMapDomainStrategy.MIN_MAX },
        };

        const nextColormap = {
            ...layer.layerRenderInfo.colormap,
            config: mergedColorMap,
        };

        if (layer.layerInfo.typeLayer === 'raster') {
            const rasterLayer = layer as RasterLayer;
            const rasterValues = rasterLayer.rasterValues;
            if (rasterValues.length > 0) {
                const domain = ColorMap.resolveDomainFromData(rasterValues, mergedColorMap);
                nextColormap.computedDomain = domain;
                nextColormap.computedLabels = ColorMap.computeLabels(domain);
                layer.updateLayerRenderInfo({ colormap: nextColormap });
                rasterLayer.loadRaster(rasterValues);
                rasterLayer.makeLayerDataDirty();
                this._ui.refreshLegend(layer);
                return;
            }
        } else {
            const vectorLayer = layer as VectorLayer | SpriteLayer;
            const thematicValues = vectorLayer.thematic;
            if (thematicValues.length > 0) {
                const existingDomain = layer.layerRenderInfo.colormap.computedDomain;
                const domain = Array.isArray(existingDomain)
                    && existingDomain.length > 0
                    && existingDomain.every(v => typeof v === 'string')
                    ? existingDomain
                    : ColorMap.resolveDomainFromData(thematicValues, mergedColorMap);
                nextColormap.computedDomain = domain;
                nextColormap.computedLabels = ColorMap.computeLabels(domain);
            }
        }

        layer.updateLayerRenderInfo({ colormap: nextColormap });
        this._ui.refreshLegend(layer);
    }

    /**
     * Updates one or more render properties of a layer.
     *
     * @param id Layer identifier.
     * @param params Render update parameters.
     * @param params.renderInfo Render properties to update.
     * @returns Nothing. The target layer render state is updated in place.
     * @throws Never throws. Unknown layers are silently ignored.
     */
    updateRenderInfo(id: string, params: UpdateRenderInfoParams | Partial<LayerRenderInfo>): void {
        const layer = this._layerManager.searchByLayerId(id);
        if (!layer) { return; }

        const info = 'renderInfo' in params ? params.renderInfo : params;

        const nextInfo: Partial<LayerRenderInfo> = { ...info };

        let needsLegend = false;
        let needsLayerList = false;

        if ('isColorMap' in info) {
            needsLegend = true;
            needsLayerList = true;
        }
        if ('isSkip' in info) {
            needsLayerList = true;
        }
        if ('isPick' in nextInfo) {
            if (nextInfo.isPick === true) {
                this.deactivateOtherPickingLayers(id);
            } else if (nextInfo.isPick === false) {
                layer.clearHighlightedIds();
                nextInfo.pickedComps = undefined;
            }
            needsLayerList = true;
        }
        layer.updateLayerRenderInfo(nextInfo);

        if (needsLegend) { this._ui.refreshLegend(layer); }
        if (needsLayerList) { this._ui.refreshLayerList(); }
    }

    /**
     * Removes all layers matching the provided id.
     *
     * @param id Layer identifier.
     * @returns Nothing. Matching layers are removed from the map.
     * @throws Never throws. Unknown ids are silently ignored.
     */
    removeLayer(id: string): void {
        this._layerManager.removeLayerById(id);
        this._ui.handleLayerRemoved(id);
        this._ui.refreshLayerList();
    }

    /**
     * Replaces the highlighted selection of a pickable layer.
     *
     * @param id Layer identifier.
     * @param selection Component ids to highlight.
     * @returns Nothing. Unsupported layers are ignored.
     * @throws Never throws.
     */
    setHighlightedIds(id: string, selection: number[]): void {
        const layer = this._layerManager.searchByLayerId(id);
        if (!layer || !layer.supportsHighlight) {
            return;
        }

        layer.setHighlightedIds(selection);
    }

    /**
     * Clears the highlighted selection of a pickable layer.
     *
     * @param id Layer identifier.
     * @returns Nothing. Unsupported layers are ignored.
     * @throws Never throws.
     */
    clearHighlightedIds(id: string): void {
        const layer = this._layerManager.searchByLayerId(id);
        if (!layer || !layer.supportsHighlight) {
            return;
        }

        layer.clearHighlightedIds();
    }

    /**
     * Toggles skipped rendering for the provided component ids of a vector layer.
     *
     * @param id Layer identifier.
     * @param selection Component ids to skip/unskip.
     * @returns Nothing. Non-vector layers are ignored.
     * @throws Never throws.
     */
    setSkippedIds(id: string, selection: number[]): void {
        const layer = this._layerManager.searchByLayerId(id);
        if (!(layer instanceof VectorLayer)) {
            return;
        }

        layer.setSkippedIds(selection);
    }

    /**
     * Clears skipped rendering state for a vector layer.
     *
     * @param id Layer identifier.
     * @returns Nothing. Non-vector layers are ignored.
     * @throws Never throws.
     */
    clearSkippedIds(id: string): void {
        const layer = this._layerManager.searchByLayerId(id);
        if (!(layer instanceof VectorLayer)) {
            return;
        }

        layer.clearSkippedIds();
    }

    enableTerrainMode(collection: FeatureCollection<Geometry | null>, property: string): void {
        if (!this.layerManager.hasOrigin) {
            throw new Error('Terrain mode requires at least one map layer to initialize the map origin first.');
        }

        this._terrainSource = terrainSourceFromRaster(collection, property, this.layerManager.origin);
        this.fitCameraToTerrainBounds(this._terrainSource.bounds);
        this._renderer.configureOverlayTexture(
            Math.max(1, this._renderer.pixelWidth),
            Math.max(1, this._renderer.pixelHeight),
        );
        this.rebuildTerrainRenderer();
    }

    private rebuildTerrainRenderer(): void {
        if (!this._terrainSource) {
            return;
        }

        this._terrainRenderer?.destroy();
        this._terrainRenderer = new TerrainRenderer(
            this._renderer.device,
            this._renderer.canvasFormat,
            'depth32float',
            this._renderer.sampleCount,
            this._terrainSource,
            this._renderer.overlayTextureView,
        );
    }

    private fitCameraToTerrainBounds(bounds: readonly [number, number, number, number]): void {
        const width = Math.max(bounds[2] - bounds[0], 1);
        const height = Math.max(bounds[3] - bounds[1], 1);
        const centerX = (bounds[0] + bounds[2]) * 0.5;
        const centerY = (bounds[1] + bounds[3]) * 0.5;
        const aspect = Math.max(this._renderer.pixelWidth / Math.max(this._renderer.pixelHeight, 1), 1e-6);
        const halfFovTangent = Math.tan(this._camera.getFovyRadians() * 0.5);
        const distanceForHeight = height / (2 * halfFovTangent);
        const distanceForWidth = width / (2 * halfFovTangent * aspect);
        const distance = Math.max(distanceForHeight, distanceForWidth) * 1.08;

        this._camera.resetCamera([0, 1, 0], [centerX, centerY, 0], [centerX, centerY, distance]);
        this._camera.resize(this._renderer.pixelWidth, this._renderer.pixelHeight);
    }

    disableTerrainMode(): void {
        this._terrainRenderer?.destroy();
        this._terrainRenderer = null;
        this._terrainSource = null;
    }

    updateTerrainDebug(options: Partial<typeof this._terrainDebug>): void {
        this._terrainDebug = { ...this._terrainDebug, ...options };
    }

    /**
     * Starts the continuous render loop at the target frame rate.
     *
     * @param fps Target frames per second (default `60`). Pass `0` to render as fast as possible.
     * @returns Nothing. Rendering is scheduled via `requestAnimationFrame`.
     * @throws Never throws.
     * @example
     * map.draw(30);  // render at 30 fps
     */
    draw(fps: number = 60) {
        if (this._isDestroyed) {
            return;
        }

        if (this._animationFrameId !== null) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }

        let previousDelta = 0;

        const update = (currentDelta: number) => {
            if (this._isDestroyed) {
                this._animationFrameId = null;
                return;
            }

            this._animationFrameId = requestAnimationFrame(update);
            const delta = currentDelta - previousDelta;

            if (fps && delta < 1000 / fps) {
                return;
            }

            this.render();
            previousDelta = currentDelta;
        };

        this._animationFrameId = requestAnimationFrame(update);
    }

    /**
     * Tears down map resources, event bindings, and GPU allocations.
     *
     * @returns Nothing. Repeated calls after destruction are ignored.
     * @throws Never throws.
     * @example
     * map.destroy();
     */
    destroy(): void {
        if (this._isDestroyed) {
            return;
        }

        if (this._animationFrameId !== null) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }

        this._keyEvents.destroyEvents();
        this._mouseEvents.destroyEvents();
        this._resizeEvents.destroyEvents();

        this._layerManager.layers.forEach((layer) => {
            layer.destroy();
        });

        this._ui.destroy();
        this._renderer.destroy();
        this._terrainRenderer?.destroy();

        this._isDestroyed = true;
    }

    /**
     * Infers a layer type from a homogeneous collection of vector geometries.
     *
     * Returns `null` when the collection is empty, contains only null geometries,
     * or mixes multiple geometry families that require an explicit layer type.
     *
     * @param collection Source feature collection to inspect.
     * @param layerId Layer identifier used in diagnostics.
     * @returns Inferred layer family, or `null` when inference fails.
     */
    private inferCollectionLayerType(collection: FeatureCollection<Geometry | null>, layerId: string): LayerType | null {
        const families = new Set<Extract<LayerType, 'points' | 'polygons' | 'polylines'>>();
        const visitGeometry = (geometry: Geometry | null, featureIndex: number): void => {
            if (!geometry) {
                console.warn(`Layer "${layerId}": feature ${featureIndex} has null geometry and will be ignored during type inference.`);
                return;
            }

            if (geometry.type === 'GeometryCollection') {
                for (const child of geometry.geometries) {
                    visitGeometry(child, featureIndex);
                }
                return;
            }

            families.add(mapGeometryTypeToLayerType(geometry.type));
        };

        for (let index = 0; index < collection.features.length; index++) {
            const feature = collection.features[index];
            visitGeometry(feature.geometry, index);
            if (families.size > 1) {
                console.error(
                    `Layer "${layerId}": cannot infer layer type from mixed geometry families. Pass an explicit type or split the collection.`
                );
                return null;
            }
        }

        const [family] = families;
        if (family) {
            return family;
        }

        console.error(`Layer "${layerId}": cannot infer layer type from an empty or geometry-less collection.`);
        return null;
    }

    /**
     * Executes one render frame, including normal and picking passes.
     *
     * @returns Nothing. Rendering commands are recorded and submitted to the GPU.
     */
    private render() {
        try {
            this._renderFrame();
        } catch (error) {
            if (!this._renderErrorLogged) {
                console.warn('AutkMap render skipped:', error);
                this._renderErrorLogged = true;
            }
        }
    }

    private _renderFrame() {
        this._camera.update();
        if (this._terrainRenderer) {
            this._renderTerrainFrame();
            return;
        }

        const activePickingLayer = this.activePickingLayer;
        const pendingPick = activePickingLayer
            && !activePickingLayer.layerRenderInfo.isSkip
            && activePickingLayer.layerRenderInfo.pickedComps
            ? (() => {
                const [x, y] = activePickingLayer.layerRenderInfo.pickedComps!;
                activePickingLayer.layerRenderInfo.pickedComps = undefined;
                return { layer: activePickingLayer, vectorLayer: activePickingLayer as VectorLayer, x, y };
            })()
            : null;

        // Normal render pass
        this._renderer.start();
        const visible3DLayers = this._layerManager.layers.filter(
            (layer): layer is Triangles3DLayer => !layer.layerRenderInfo.isSkip && layer instanceof Triangles3DLayer
        );
        this._layerManager.layers.forEach((layer) => {
            if (!layer.layerRenderInfo.isSkip) {
                layer.prepareRender(this._camera);
            }
        });
        if (visible3DLayers.length > 0) {
            const geometryPassEncoder = PipelineBuildingSSAO.beginSharedGeometryPass(this._renderer);
            visible3DLayers.forEach((layer) => {
                layer.renderSceneGeometry(this._camera, geometryPassEncoder);
            });
            geometryPassEncoder.end();
        }
        const mainPassEncoder = this._renderer.beginMainRenderPass();
        this._layerManager.layers.forEach((layer) => {
            if (!layer.layerRenderInfo.isSkip && !(layer instanceof Triangles3DLayer)) {
                layer.renderPass(this._camera, mainPassEncoder);
            }
        });
        if (visible3DLayers.length > 0) {
            PipelineBuildingSSAO.compositeSharedPass(this._renderer, mainPassEncoder);
        }
        mainPassEncoder.end();

        let pickReadbackSlot: number | null = null;
        if (pendingPick) {
            this._renderer.startPickingRenderPass();
            pendingPick.layer.renderPickingPass(this._camera);

            pickReadbackSlot = this._renderer.reservePickingReadbackSlot(1);
            if (pickReadbackSlot === null) {
                console.warn('Picking readback buffers are still busy; skipping this picking frame.');
            } else {
                this._renderer.enqueuePickingReadback(pickReadbackSlot, 0, pendingPick.x, pendingPick.y);
            }
        }

        this._renderer.finish();

        if (pickReadbackSlot !== null && pendingPick) {
            this._renderer.readPickingResults(pickReadbackSlot, 1).then((ids) => {
                const id = ids[0] ?? -1;
                const { layer, vectorLayer } = pendingPick;

                if (id >= 0) {
                    vectorLayer.toggleHighlightedIds([id]);
                    this._mapEvents.emit(MapEvent.PICKING, { selection: vectorLayer.highlightedIds, layerId: layer.layerInfo.id });
                } else {
                    layer.clearHighlightedIds();
                    this._mapEvents.emit(MapEvent.PICKING, { selection: [], layerId: layer.layerInfo.id });
                }
            });
        }
    }

    private _renderTerrainFrame(): void {
        const terrain = this._terrainRenderer;
        if (!terrain) {
            return;
        }

        this._renderer.start();
        const overlayResized = this._renderer.configureOverlayTexture(
            Math.max(1, this._renderer.pixelWidth),
            Math.max(1, this._renderer.pixelHeight),
        );
        if (overlayResized) {
            this.rebuildTerrainRenderer();
        }
        const activeTerrain = this._terrainRenderer;
        if (!activeTerrain) {
            return;
        }
        const overlayBounds = this.computeTerrainVisibleBounds(activeTerrain.bounds);
        this._terrainOverlayCamera.setOrthographicBounds(
            overlayBounds[0],
            overlayBounds[2],
            overlayBounds[1],
            overlayBounds[3],
        );

        this._layerManager.layers.forEach((layer) => {
            if (!layer.layerRenderInfo.isSkip && !(layer instanceof Triangles3DLayer)) {
                layer.prepareRender(this._terrainOverlayCamera);
            }
        });
        const overlayPass = this._renderer.beginOverlayRenderPass();
        this._layerManager.layers.forEach((layer) => {
            if (!layer.layerRenderInfo.isSkip && !(layer instanceof Triangles3DLayer)) {
                layer.renderPass(this._terrainOverlayCamera, overlayPass);
            }
        });
        overlayPass.end();

        activeTerrain.update(this._camera, overlayBounds, this._terrainDebug);
        const terrainPass = this._renderer.beginMainRenderPass();
        activeTerrain.render(terrainPass, this._terrainDebug.showMesh);
        terrainPass.end();
        this._renderer.finish();
    }

    private computeTerrainVisibleBounds(terrainBounds: readonly [number, number, number, number]): [number, number, number, number] {
        const points: Array<[number, number]> = [];
        const eye = this._camera.getEye();
        const lookAt = this._camera.getLookAt();
        const forwardX = lookAt[0] - eye[0];
        const forwardY = lookAt[1] - eye[1];
        const forwardLength = Math.hypot(forwardX, forwardY);
        const hasHorizontalForward = forwardLength > 1e-3;
        const normalizedForward: [number, number] = hasHorizontalForward
            ? [forwardX / forwardLength, forwardY / forwardLength]
            : [0, 1];
        const corners: Array<[number, number]> = [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
            [0.5, 0.5],
        ];

        for (const [x, y] of corners) {
            const direction = this._camera.getWorldRayDirection(x, y);
            if (Math.abs(direction[2]) < 1e-6) {
                continue;
            }

            const t = -eye[2] / direction[2];
            if (t <= 0) {
                continue;
            }

            points.push([eye[0] + direction[0] * t, eye[1] + direction[1] * t]);
        }

        if (points.length === 0) {
            points.push([lookAt[0], lookAt[1]]);
        }

        const cameraHeight = Math.max(Math.abs(eye[2]), 1);
        const terrainWidth = terrainBounds[2] - terrainBounds[0];
        const terrainHeight = terrainBounds[3] - terrainBounds[1];
        const terrainMaxSpan = Math.max(terrainWidth, terrainHeight);
        const visibleDistance = clampNumber(cameraHeight * 6, cameraHeight * 1.5, terrainMaxSpan);
        const lookAheadDistance = visibleDistance * 0.75;
        const aspect = Math.max(this._renderer.pixelWidth / Math.max(this._renderer.pixelHeight, 1), 1e-6);
        if (hasHorizontalForward) {
            const right: [number, number] = [normalizedForward[1], -normalizedForward[0]];
            const lateralHalfSpan = Math.min(
                Math.max(
                    cameraHeight * Math.tan(this._camera.getFovyRadians() * 0.5) * aspect * 1.25,
                    visibleDistance * 0.35,
                ),
                terrainMaxSpan * 0.5,
            );
            const cameraPoint: [number, number] = [eye[0], eye[1]];
            const lookAheadPoint: [number, number] = [
                eye[0] + normalizedForward[0] * lookAheadDistance,
                eye[1] + normalizedForward[1] * lookAheadDistance,
            ];

            points.push(cameraPoint, lookAheadPoint);
            for (const point of [cameraPoint, lookAheadPoint]) {
                points.push(
                    [point[0] + right[0] * lateralHalfSpan, point[1] + right[1] * lateralHalfSpan],
                    [point[0] - right[0] * lateralHalfSpan, point[1] - right[1] * lateralHalfSpan],
                );
            }
        }

        const rawMinX = Math.min(...points.map((point) => point[0]));
        const rawMaxX = Math.max(...points.map((point) => point[0]));
        const rawMinY = Math.min(...points.map((point) => point[1]));
        const rawMaxY = Math.max(...points.map((point) => point[1]));
        let width = Math.max(rawMaxX - rawMinX, 1);
        let height = Math.max(rawMaxY - rawMinY, 1);
        const rawCenterX = (rawMinX + rawMaxX) * 0.5;
        const rawCenterY = (rawMinY + rawMaxY) * 0.5;
        const focusX = hasHorizontalForward ? eye[0] + normalizedForward[0] * lookAheadDistance * 0.5 : rawCenterX;
        const focusY = hasHorizontalForward ? eye[1] + normalizedForward[1] * lookAheadDistance * 0.5 : rawCenterY;
        const maxForwardSpan = Math.min(visibleDistance * 1.5, terrainMaxSpan);
        const maxLateralSpan = Math.min(visibleDistance * 3.0, terrainMaxSpan);
        const maxWidth = Math.max(maxLateralSpan, maxForwardSpan * aspect);
        const maxHeight = Math.max(maxForwardSpan, maxLateralSpan / Math.max(aspect, 1e-6));
        width = Math.min(width, maxWidth);
        height = Math.min(height, maxHeight);

        const texelX = width / Math.max(1, this._renderer.pixelWidth);
        const texelY = height / Math.max(1, this._renderer.pixelHeight);
        let minX = Math.floor((focusX - width * 0.5) / texelX) * texelX;
        let minY = Math.floor((focusY - height * 0.5) / texelY) * texelY;
        let maxX = minX + width;
        let maxY = minY + height;

        if (minX < terrainBounds[0]) {
            maxX += terrainBounds[0] - minX;
            minX = terrainBounds[0];
        }
        if (maxX > terrainBounds[2]) {
            minX -= maxX - terrainBounds[2];
            maxX = terrainBounds[2];
        }
        if (minY < terrainBounds[1]) {
            maxY += terrainBounds[1] - minY;
            minY = terrainBounds[1];
        }
        if (maxY > terrainBounds[3]) {
            minY -= maxY - terrainBounds[3];
            maxY = terrainBounds[3];
        }

        return [
            Math.max(minX, terrainBounds[0]),
            Math.max(minY, terrainBounds[1]),
            Math.min(maxX, terrainBounds[2]),
            Math.min(maxY, terrainBounds[3]),
        ];
    }

    /**
     * Clears picking state from every layer except the requested one.
     *
     * @param activeLayerId Identifier of the layer that should remain pick-enabled.
     * @returns Nothing. Other pick-enabled layers are deactivated.
     */
    private deactivateOtherPickingLayers(activeLayerId: string): void {
        this._layerManager.layers.forEach((otherLayer) => {
            if (otherLayer.layerInfo.id === activeLayerId || !otherLayer.layerRenderInfo.isPick) {
                return;
            }

            otherLayer.clearHighlightedIds();
            otherLayer.updateLayerRenderInfo({ isPick: false, pickedComps: undefined });
        });
    }

    /**
     * Creates a polygon-based vector layer from GeoJSON.
     *
     * @param layerName Target layer id.
     * @param geojson Source feature collection.
     * @param typeLayer Layer type.
     * @param property Optional value extractor used to initialize thematic data.
     * @returns Nothing. The layer is created when triangulation succeeds.
      */
    private createPolygonsLayer(layerName: string, geojson: FeatureCollection, typeLayer: LayerType, property?: string) {
        const layerInfo: LayerInfo = {
            id: `${layerName}`,
            zIndex: this._layerManager.computeZindex(typeLayer),
            typeLayer: typeLayer,
        };

        const layerRenderInfo: LayerRenderInfo = {
            opacity: 1.0,
            colormap: { config: this.defaultColorMap() },
            isColorMap: false,
            isPick: false,
            isSkip: false,
        };

        const layerMesh = TriangulatorPolygons.buildMesh(geojson, this.layerManager.origin);
        if (layerMesh[0].length === 0 || layerMesh[1].length === 0) {
            console.error('Invalid Polygon Layer');
            return;
        }

        let layerBorder: [LayerData['border'], LayerData['borderComponents']];
        if (typeLayer === 'polygons') {
            layerBorder = TriangulatorPolygons.buildBorder(geojson, this.layerManager.origin);
            if (!layerBorder[0] || !layerBorder[1] || layerBorder[0].length === 0 || layerBorder[1].length === 0) {
                console.error('Invalid Polygon Layer border.');
                return;
            }
        } else {
            layerBorder = [[], []];
        }

        const layerData = {
            geometry: layerMesh[0],
            components: layerMesh[1],
            border: layerBorder[0],
            borderComponents: layerBorder[1],
            thematic: layerMesh[1].map(() => {
                return {
                    value: 0,
                    valid: 1,
                };
            }),
        };

        this.createLayer(layerInfo, layerRenderInfo, layerData);

        if (property) {
            this.updateThematic(layerName, { collection: geojson, property  });
        }
    }

    /**
     * Creates a polyline-based vector layer from GeoJSON.
     *
     * @param layerName Target layer id.
     * @param geojson Source feature collection.
     * @param typeLayer Layer type.
     * @param property Optional value extractor used to initialize thematic data.
     * @returns Nothing. The layer is created when triangulation succeeds.
      */
    private createPolylinesLayer(layerName: string, geojson: FeatureCollection, typeLayer: LayerType, property?: string, polylinesWidth?: number) {
        const layerInfo: LayerInfo = {
            id: `${layerName}`,
            zIndex: this._layerManager.computeZindex(typeLayer),
            typeLayer: typeLayer,
        };

        const layerRenderInfo: LayerRenderInfo = {
            opacity: 1.0,
            colormap: { config: this.defaultColorMap() },
            isColorMap: false,
            isPick: false,
            isSkip: false,
        };

        const fixedHalfWidth = typeof polylinesWidth === 'number' && Number.isFinite(polylinesWidth) && polylinesWidth > 0
            ? polylinesWidth / 2
            : undefined;

        TriangulatorPolylines.offset = fixedHalfWidth ?? (typeLayer === 'roads' ? TriangulatorPolylines.DEFAULT_ROAD_HALF_WIDTH : 8.5);
        const layerMesh = typeLayer === 'roads' && fixedHalfWidth === undefined
            ? TriangulatorPolylines.buildMesh(
                geojson,
                this.layerManager.origin,
                TriangulatorPolylines.resolveRoadHalfWidth
            )
            : TriangulatorPolylines.buildMesh(geojson, this.layerManager.origin);
        if (layerMesh[0].length === 0 || layerMesh[1].length === 0) {
            console.error('Invalid Roads Layer.');
            return;
        }

        const layerData = {
            geometry: layerMesh[0],
            components: layerMesh[1],
            thematic: layerMesh[1].map(() => {
                return {
                    value: 0,
                    valid: 1,
                };
            }),
        };

        this.createLayer(layerInfo, layerRenderInfo, layerData);

        if (property) {
            this.updateThematic(layerName, { collection: geojson, property  });
        }
    }

    /**
     * Creates a point-based vector layer from GeoJSON.
     *
     * @param layerName Target layer id.
     * @param geojson Source feature collection.
     * @param typeLayer Layer type.
     * @param property Optional value extractor used to initialize thematic data.
     * @returns Nothing. The layer is created when triangulation succeeds.
      */
    private createPointsLayer(layerName: string, geojson: FeatureCollection, typeLayer: LayerType, property?: string) {
        const layerInfo: LayerInfo = {
            id: `${layerName}`,
            zIndex: this._layerManager.computeZindex(typeLayer),
            typeLayer: typeLayer,
        };

        const layerRenderInfo: LayerRenderInfo = {
            opacity: 1.0,
            colormap: { config: this.defaultColorMap() },
            isColorMap: false,
            isPick: false,
            isSkip: false,
        };

        const pointInstances = TriangulatorPoints.buildInstances(geojson, this.layerManager.origin);
        if (pointInstances.instances.length === 0 || pointInstances.components.length === 0) {
            console.error('Invalid Points Layer.');
            return;
        }

        const layerData = {
            geometry: [],
            components: pointInstances.components,
            pointInstances: pointInstances.instances,
            pointInstanceCount: pointInstances.instances.length / 2,
            pointSize: TriangulatorPoints.getPointSize(),
            thematic: pointInstances.components.map(() => {
                return {
                    value: 0,
                    valid: 1,
                };
            }),
        };

        this.createLayer(layerInfo, layerRenderInfo, layerData);

        if (property) {
            this.updateThematic(layerName, { collection: geojson, property  });
        }
    }

    /**
     * Creates a buildings vector layer from GeoJSON.
     *
     * @param layerName Target layer id.
     * @param geojson Source feature collection.
     * @param typeLayer Layer type.
     * @param property Optional value extractor used to initialize thematic data.
     * @returns Nothing. The layer is created when triangulation succeeds.
      */
    private createBuildingsLayer(layerName: string, geojson: FeatureCollection, typeLayer: LayerType, property?: string, buildingsZeroHeight?: boolean) {
        const layerInfo: LayerInfo = {
            id: `${layerName}`,
            zIndex: this._layerManager.computeZindex(typeLayer),
            typeLayer: 'buildings',
        };

        const layerRenderInfo: LayerRenderInfo = {
            opacity: 1.0,
            colormap: { config: this.defaultColorMap() },
            isColorMap: false,
            isPick: false,
            isSkip: false,
        };

        const layerMesh = TriangulatorBuildings.buildMesh(geojson, this.layerManager.origin, buildingsZeroHeight);
        if (layerMesh[0].length === 0 || layerMesh[1].length === 0) {
            console.error('Invalid Building Layer.');
            return;
        }

        const layerData = {
            geometry: layerMesh[0],
            components: layerMesh[1],
            thematic: layerMesh[1].map(() => {
                return {
                    value: 0,
                    valid: 1,
                };
            }),
        };

        this.createLayer(layerInfo, layerRenderInfo, layerData);

        if (property) {
            this.updateThematic(layerName, { collection: geojson, property  });
        }
    }

    /**
     * Creates a raster layer from a GeoTIFF-derived feature collection.
     *
     * @param layerName Target layer id.
     * @param geotiff GeoTIFF-derived feature collection.
     * @param property Feature-property path selecting the raster band array.
     * @returns Nothing. The raster layer is created and initialized.
     */
    private createRasterLayer(layerName: string, geotiff: FeatureCollection<Geometry | null>, property: string) {
        const layerInfo: LayerInfo = {
            id: `${layerName}`,
            zIndex: this._layerManager.computeZindex('raster'),
            typeLayer: 'raster',
        };

        const layerRenderInfo: LayerRenderInfo = {
            opacity: 1.0,
            colormap: { config: this.defaultColorMap() },
            isColorMap: false,
            isPick: false,
            isSkip: false,
        };

        const layerMesh = TriangulatorRaster.buildMesh(geotiff, this.layerManager.origin);
        if (layerMesh[0].length === 0 || layerMesh[1].length === 0) {
            console.error('Invalid Feature Layer.');
            return;
        }

        const props = geotiff.features[0].properties;
        if (!props) {
            console.error('GeoTIFF properties are missing.');
            return;
        }

        const layerData: LayerData = {
            geometry: layerMesh[0],
            components: layerMesh[1],
            rasterResX: props.rasterResX,
            rasterResY: props.rasterResY,
        };

        this.createLayer(layerInfo, layerRenderInfo, layerData);
        this.updateRaster(layerName, { collection: geotiff, property  });
    }

    /**
     * Creates a layer from the provided information.
     *
     * @param layerInfo Metadata describing the layer.
     * @param layerRenderInfo Initial render configuration.
     * @param layerData Triangulated geometry/components payload.
     * @returns Nothing. The layer pipeline is created when layer registration succeeds.
     */
    private createLayer(layerInfo: LayerInfo, layerRenderInfo: LayerRenderInfo, layerData: LayerData) {
        const layer = this._layerManager.addLayer(layerInfo, layerRenderInfo, layerData);
        if (layer) {
            layer.createPipeline(this._renderer);
        }
    }

    /**
     * Returns the default color-map configuration used for newly created layers.
     *
     * @returns Default sequential red colormap with min/max numeric domain inference.
     */
    private defaultColorMap(): ColorMapConfig {
        return {
            interpolator: ColorMapInterpolator.SEQ_REDS,
            domainSpec: { type: ColorMapDomainStrategy.MIN_MAX },
        };
    }
}
