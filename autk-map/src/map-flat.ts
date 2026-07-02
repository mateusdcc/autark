/**
 * @module map-flat
 * Flat map render-path orchestration.
 *
 * This module contains the frame logic used when terrain mode is disabled. It
 * keeps the normal layer render path separate from `AutkMap` while reusing the
 * shared renderer, camera, layer manager, and picking controller.
 */

import { Camera } from '@urban-toolkit/autk-core';

import { LayerManager } from './layer-manager';
import { Triangles3DLayer } from './layer-triangles3D';
import { MapPickingController } from './map-picking';
import { PipelineBuildingSSAO } from './pipeline-triangle-ssao';
import { Renderer } from './renderer';

/**
 * Coordinates one non-terrain map frame.
 *
 * The path renders visible layers, composites shared building SSAO output, and
 * resolves one pending picking request when present.
 */
export class FlatMapRenderPath {
    /**
     * Creates a flat render path using shared map services.
     *
     * @param renderer WebGPU renderer that owns frame targets and command encoders.
     * @param camera Active map camera used by all layer render passes.
     * @param layerManager Ordered source of map layers to draw.
     * @param picking Shared controller for picking readback and event emission.
     * @throws Never throws.
     * @example
     * const path = new FlatMapRenderPath(renderer, camera, layerManager, picking);
     * path.renderFrame();
     */
    constructor(
        /** WebGPU renderer used to open and submit frame passes. */
        private readonly renderer: Renderer,
        /** Active camera used for flat layer preparation and rendering. */
        private readonly camera: Camera,
        /** Ordered collection of layers participating in the frame. */
        private readonly layerManager: LayerManager,
        /** Shared picking helper used before and after render submission. */
        private readonly picking: MapPickingController,
    ) {}

    /**
     * Resets the main camera to the default flat map view.
     *
     * @returns Nothing. The camera state and viewport matrices are updated.
     * @throws Never throws.
     * @example
     * flatPath.resetCamera();
     */
    resetCamera(): void {
        this.camera.resetCamera([0, 1, 0], [0, 0, 0], [0, 0, 10000]);
        this.camera.resize(this.renderer.pixelWidth, this.renderer.pixelHeight);
    }

    /**
     * Renders one flat map frame.
     *
     * The method prepares visible layers, renders 3D building geometry into the
     * shared SSAO buffers, renders non-3D layers to the main target, and then
     * optionally performs one picking pass.
     *
     * @returns Nothing. GPU commands are submitted through the renderer.
     * @throws Propagates renderer or layer errors to the caller's frame guard.
     * @example
     * flatPath.renderFrame();
     */
    renderFrame(): void {
        const pendingPick = this.picking.consumePendingPick();

        this.renderer.start();
        const visible3DLayers = this.layerManager.layers.filter(
            (layer): layer is Triangles3DLayer => !layer.layerRenderInfo.isSkip && layer instanceof Triangles3DLayer
        );
        this.layerManager.layers.forEach((layer) => {
            if (!layer.layerRenderInfo.isSkip) {
                layer.prepareRender(this.camera);
            }
        });
        if (visible3DLayers.length > 0) {
            const geometryPassEncoder = PipelineBuildingSSAO.beginSharedGeometryPass(this.renderer);
            visible3DLayers.forEach((layer) => {
                layer.renderSceneGeometry(this.camera, geometryPassEncoder);
            });
            geometryPassEncoder.end();
        }
        const mainPassEncoder = this.renderer.beginMainRenderPass();
        this.layerManager.layers.forEach((layer) => {
            if (!layer.layerRenderInfo.isSkip && !(layer instanceof Triangles3DLayer)) {
                layer.renderPass(this.camera, mainPassEncoder);
            }
        });
        if (visible3DLayers.length > 0) {
            PipelineBuildingSSAO.compositeSharedPass(this.renderer, mainPassEncoder);
        }
        mainPassEncoder.end();

        let pickReadbackSlot: number | null = null;
        if (pendingPick) {
            this.renderer.startPickingRenderPass();
            pendingPick.layer.renderPickingPass(this.camera);
            pickReadbackSlot = this.picking.enqueuePickingReadback(pendingPick);
        }

        this.renderer.finish();
        this.picking.resolvePickingReadback(pendingPick, pickReadbackSlot);
    }
}
