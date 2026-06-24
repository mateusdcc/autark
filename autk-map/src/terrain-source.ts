import type { FeatureCollection, Geometry } from 'geojson';
import { valueAtPath } from '@urban-toolkit/autk-core';

export interface TerrainSource {
    width: number;
    height: number;
    originX: number;
    originY: number;
    cellSizeX: number;
    cellSizeY: number;
    minHeight: number;
    maxHeight: number;
    data: Float32Array;
    bounds: [number, number, number, number];
}

export function terrainSourceFromRaster(
    collection: FeatureCollection<Geometry | null>,
    property: string,
    origin: readonly number[],
): TerrainSource {
    const feature = collection.features[0];
    const props = feature?.properties as Record<string, unknown> | undefined;

    const rasterValues = props ? valueAtPath(props, property) : undefined;

    if (!props || !isArrayLike(rasterValues) || !collection.bbox) {
        throw new Error(`Terrain source requires a raster FeatureCollection with bbox and '${property}' band values.`);
    }

    const width = Number(props.rasterResX);
    const height = Number(props.rasterResY);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
        throw new Error('Terrain source raster resolution must be at least 2x2.');
    }

    const values = Array.from(rasterValues, Number);
    if (values.length !== width * height) {
        throw new Error(`Terrain source has ${values.length} cells; expected ${width * height}.`);
    }

    const data = new Float32Array(values);
    let minHeight = Number.POSITIVE_INFINITY;
    let maxHeight = Number.NEGATIVE_INFINITY;
    for (const value of data) {
        if (Number.isFinite(value)) {
            minHeight = Math.min(minHeight, value);
            maxHeight = Math.max(maxHeight, value);
        }
    }

    if (!Number.isFinite(minHeight) || !Number.isFinite(maxHeight)) {
        throw new Error('Terrain source does not contain finite elevation values.');
    }

    const bounds: [number, number, number, number] = [
        Number(collection.bbox[0]) - origin[0],
        Number(collection.bbox[1]) - origin[1],
        Number(collection.bbox[2]) - origin[0],
        Number(collection.bbox[3]) - origin[1],
    ];

    return {
        width,
        height,
        originX: bounds[0],
        originY: bounds[1],
        cellSizeX: (bounds[2] - bounds[0]) / Math.max(1, width - 1),
        cellSizeY: (bounds[3] - bounds[1]) / Math.max(1, height - 1),
        minHeight,
        maxHeight,
        data,
        bounds,
    };
}

function isArrayLike(value: unknown): value is ArrayLike<unknown> {
    return Array.isArray(value) || ArrayBuffer.isView(value);
}
