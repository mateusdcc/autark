import type { Camera } from '@urban-toolkit/autk-core';
import terrainFragmentSource from './shaders/terrain.frag.wgsl';
import terrainVertexSource from './shaders/terrain.vert.wgsl';
import terrainBoundsReduceSource from './shaders/terrain-bounds-reduce.comp.wgsl';
import type { TerrainSource } from './terrain-source';

const PATCH_CELLS = 32;
const PATCH_VERTICES = PATCH_CELLS + 1;
const MAX_LOD_LEVEL = 7;
const MAX_INSTANCES = 4096;
const TARGET_CELL_PIXELS = 30;
const TERRAIN_LOD_REFERENCE_HEIGHT = 0;
const BOUNDS_PREPASS_SIZE = 512;
const REDUCE_WORKGROUP_SIZE = 256;
const BOUNDS_PIXEL_COUNT = BOUNDS_PREPASS_SIZE * BOUNDS_PREPASS_SIZE;
const BOUNDS_PASS_1_COUNT = Math.ceil(BOUNDS_PIXEL_COUNT / REDUCE_WORKGROUP_SIZE);
const BOUNDS_PASS_2_COUNT = Math.ceil(BOUNDS_PASS_1_COUNT / REDUCE_WORKGROUP_SIZE);
const BOUNDS_PASS_3_COUNT = Math.ceil(BOUNDS_PASS_2_COUNT / REDUCE_WORKGROUP_SIZE);

type Plane = [number, number, number, number];

interface TerrainMesh {
    vertexBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    lineIndexBuffer: GPUBuffer;
    indexCount: number;
    lineIndexCount: number;
}

interface BlockCandidate {
    x: number;
    y: number;
    size: number;
    level: number;
    seamXMin: number;
    seamXMax: number;
    seamYMin: number;
    seamYMax: number;
}

export interface TerrainDebugOptions {
    showMesh?: boolean;
    enableCulling?: boolean;
    freezeLod?: boolean;
}

export interface TerrainStats {
    selectedBlocks: number;
    triangles: number;
    culledBlocks: number;
}

export class TerrainRenderer {
    readonly stats: TerrainStats = { selectedBlocks: 0, triangles: 0, culledBlocks: 0 };
    readonly bounds: [number, number, number, number];

    private readonly pipeline: GPURenderPipeline;
    private readonly depthPipeline: GPURenderPipeline;
    private readonly meshPipeline: GPURenderPipeline;
    private readonly boundsPipeline: GPURenderPipeline;
    private readonly visibleBoundsPipeline: GPURenderPipeline;
    private readonly reduceTexturePipeline: GPUComputePipeline;
    private readonly reduceBufferPipeline: GPUComputePipeline;
    private readonly cameraBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    private readonly instanceBuffer: GPUBuffer;
    private readonly boundsVertexBuffer: GPUBuffer;
    private readonly heightTexture: GPUTexture;
    private readonly heightTextureView: GPUTextureView;
    private readonly visibleBoundsTexture: GPUTexture;
    private readonly visibleBoundsDepthTexture: GPUTexture;
    private readonly visibleBoundsTextureView: GPUTextureView;
    private readonly visibleBoundsDepthTextureView: GPUTextureView;
    private readonly reduceParamsTextureBuffer: GPUBuffer;
    private readonly reduceParamsPass2Buffer: GPUBuffer;
    private readonly reduceParamsPass3Buffer: GPUBuffer;
    private readonly reducePartialA: GPUBuffer;
    private readonly reducePartialB: GPUBuffer;
    private readonly reduceFinal: GPUBuffer;
    private readonly reduceReadback: GPUBuffer;
    private readonly reduceTextureBindGroup: GPUBindGroup;
    private readonly reducePass2BindGroup: GPUBindGroup;
    private readonly reducePass3BindGroup: GPUBindGroup;
    private readonly mesh: TerrainMesh;
    private readonly instanceData = new Float32Array(MAX_INSTANCES * 8);
    private readonly lastBlocks: BlockCandidate[] = [];
    private latestReducedBounds: [number, number, number, number] | null = null;
    private boundsReadbackPending = false;
    private boundsReadbackInFlight = false;
    private instanceCount = 0;

    constructor(
        private readonly device: GPUDevice,
        colorFormat: GPUTextureFormat,
        depthFormat: GPUTextureFormat,
        sampleCount: number,
        private readonly source: TerrainSource,
        overlayTextureView: GPUTextureView,
    ) {
        this.bounds = source.bounds;
        this.mesh = createPatchMesh(device);
        this.cameraBuffer = device.createBuffer({
            label: 'Terrain camera uniform buffer',
            size: 192,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.instanceBuffer = device.createBuffer({
            label: 'Terrain block instance buffer',
            size: this.instanceData.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.boundsVertexBuffer = device.createBuffer({
            label: 'Terrain overlay bounds debug vertices',
            size: 12 * 3 * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.heightTexture = device.createTexture({
            label: 'Terrain height field texture',
            size: [source.width, source.height],
            format: 'r32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.heightTextureView = this.heightTexture.createView();
        device.queue.writeTexture(
            { texture: this.heightTexture },
            source.data,
            { bytesPerRow: source.width * Float32Array.BYTES_PER_ELEMENT, rowsPerImage: source.height },
            { width: source.width, height: source.height },
        );
        this.visibleBoundsTexture = device.createTexture({
            label: 'Terrain visible bounds prepass texture',
            size: [BOUNDS_PREPASS_SIZE, BOUNDS_PREPASS_SIZE],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.visibleBoundsDepthTexture = device.createTexture({
            label: 'Terrain visible bounds prepass depth texture',
            size: [BOUNDS_PREPASS_SIZE, BOUNDS_PREPASS_SIZE],
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.visibleBoundsTextureView = this.visibleBoundsTexture.createView();
        this.visibleBoundsDepthTextureView = this.visibleBoundsDepthTexture.createView();
        this.reduceParamsTextureBuffer = createReduceParamsBuffer(device, BOUNDS_PIXEL_COUNT, BOUNDS_PREPASS_SIZE, BOUNDS_PREPASS_SIZE);
        this.reduceParamsPass2Buffer = createReduceParamsBuffer(device, BOUNDS_PASS_1_COUNT, 0, 0);
        this.reduceParamsPass3Buffer = createReduceParamsBuffer(device, BOUNDS_PASS_2_COUNT, 0, 0);
        this.reducePartialA = createStorageBuffer(device, BOUNDS_PASS_1_COUNT, 'Terrain bounds reduce partial A');
        this.reducePartialB = createStorageBuffer(device, BOUNDS_PASS_2_COUNT, 'Terrain bounds reduce partial B');
        this.reduceFinal = createStorageBuffer(device, BOUNDS_PASS_3_COUNT, 'Terrain bounds reduce final');
        this.reduceReadback = device.createBuffer({
            label: 'Terrain bounds readback buffer',
            size: 4 * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const overlaySampler = device.createSampler({
            label: 'Terrain overlay sampler',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
        });
        const bindGroupLayout = device.createBindGroupLayout({
            label: 'Terrain bind group layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            ],
        });
        this.bindGroup = device.createBindGroup({
            label: 'Terrain bind group',
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.cameraBuffer } },
                { binding: 1, resource: this.heightTextureView },
                { binding: 2, resource: overlaySampler },
                { binding: 3, resource: overlayTextureView },
            ],
        });

        const vertexShaderModule = device.createShaderModule({ label: 'Terrain vertex shader', code: terrainVertexSource });
        const fragmentShaderModule = device.createShaderModule({ label: 'Terrain fragment shader', code: terrainFragmentSource });
        const reduceShaderModule = device.createShaderModule({ label: 'Terrain bounds reduce shader', code: terrainBoundsReduceSource });
        const vertexBuffers: GPUVertexBufferLayout[] = [
            {
                arrayStride: 12,
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x2' },
                    { shaderLocation: 2, offset: 8, format: 'float32' },
                ],
            },
            {
                arrayStride: 32,
                stepMode: 'instance',
                attributes: [
                    { shaderLocation: 1, offset: 0, format: 'float32x4' },
                    { shaderLocation: 3, offset: 16, format: 'float32x4' },
                ],
            },
        ];
        const layout = device.createPipelineLayout({ label: 'Terrain pipeline layout', bindGroupLayouts: [bindGroupLayout] });
        this.pipeline = device.createRenderPipeline({
            label: 'LOD terrain pipeline',
            layout,
            vertex: { module: vertexShaderModule, entryPoint: 'vertexMain', buffers: vertexBuffers },
            fragment: { module: fragmentShaderModule, entryPoint: 'fragmentMain', targets: [{ format: colorFormat }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { depthWriteEnabled: true, depthCompare: 'greater-equal', format: depthFormat },
            multisample: { count: sampleCount },
        });
        this.depthPipeline = device.createRenderPipeline({
            label: 'LOD terrain composite depth pipeline',
            layout,
            vertex: { module: vertexShaderModule, entryPoint: 'vertexMain', buffers: vertexBuffers },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { depthWriteEnabled: true, depthCompare: 'greater-equal', format: 'depth32float' },
        });
        this.meshPipeline = device.createRenderPipeline({
            label: 'LOD terrain mesh overlay pipeline',
            layout,
            vertex: { module: vertexShaderModule, entryPoint: 'meshVertexMain', buffers: vertexBuffers },
            fragment: { module: fragmentShaderModule, entryPoint: 'meshFragmentMain', targets: [{ format: colorFormat }] },
            primitive: { topology: 'line-list' },
            depthStencil: { depthWriteEnabled: false, depthCompare: 'greater-equal', format: depthFormat },
            multisample: { count: sampleCount },
        });
        this.boundsPipeline = device.createRenderPipeline({
            label: 'Terrain overlay bounds debug pipeline',
            layout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: 'boundsVertexMain',
                buffers: [
                    {
                        arrayStride: 3 * Float32Array.BYTES_PER_ELEMENT,
                        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
                    },
                ],
            },
            fragment: { module: fragmentShaderModule, entryPoint: 'boundsFragmentMain', targets: [{ format: colorFormat }] },
            primitive: { topology: 'line-list' },
            depthStencil: { depthWriteEnabled: false, depthCompare: 'greater-equal', format: depthFormat },
            multisample: { count: sampleCount },
        });
        this.visibleBoundsPipeline = device.createRenderPipeline({
            label: 'Terrain visible bounds prepass pipeline',
            layout,
            vertex: { module: vertexShaderModule, entryPoint: 'visibleBoundsVertexMain', buffers: vertexBuffers },
            fragment: { module: fragmentShaderModule, entryPoint: 'visibleBoundsFragmentMain', targets: [{ format: 'rgba16float' }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { depthWriteEnabled: true, depthCompare: 'greater-equal', format: 'depth32float' },
        });
        const reduceTextureBindGroupLayout = device.createBindGroupLayout({
            label: 'Terrain bounds texture reduce bind group layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ],
        });
        const reduceBufferBindGroupLayout = device.createBindGroupLayout({
            label: 'Terrain bounds buffer reduce bind group layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ],
        });
        const emptyBindGroupLayout = device.createBindGroupLayout({
            label: 'Terrain bounds empty bind group layout',
            entries: [],
        });
        this.reduceTexturePipeline = device.createComputePipeline({
            label: 'Terrain bounds texture reduce pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [reduceTextureBindGroupLayout] }),
            compute: { module: reduceShaderModule, entryPoint: 'reduceTexture' },
        });
        this.reduceBufferPipeline = device.createComputePipeline({
            label: 'Terrain bounds buffer reduce pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [emptyBindGroupLayout, reduceBufferBindGroupLayout] }),
            compute: { module: reduceShaderModule, entryPoint: 'reduceBuffer' },
        });
        this.reduceTextureBindGroup = device.createBindGroup({
            label: 'Terrain bounds texture reduce bind group',
            layout: reduceTextureBindGroupLayout,
            entries: [
                { binding: 0, resource: this.visibleBoundsTextureView },
                { binding: 1, resource: { buffer: this.reducePartialA } },
                { binding: 2, resource: { buffer: this.reduceParamsTextureBuffer } },
            ],
        });
        this.reducePass2BindGroup = device.createBindGroup({
            label: 'Terrain bounds reduce pass 2 bind group',
            layout: reduceBufferBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.reducePartialA } },
                { binding: 1, resource: { buffer: this.reducePartialB } },
                { binding: 2, resource: { buffer: this.reduceParamsPass2Buffer } },
            ],
        });
        this.reducePass3BindGroup = device.createBindGroup({
            label: 'Terrain bounds reduce pass 3 bind group',
            layout: reduceBufferBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.reducePartialB } },
                { binding: 1, resource: { buffer: this.reduceFinal } },
                { binding: 2, resource: { buffer: this.reduceParamsPass3Buffer } },
            ],
        });
    }

    get terrainSource(): TerrainSource {
        return this.source;
    }

    get terrainHeightTextureView(): GPUTextureView {
        return this.heightTextureView;
    }

    get visibleBounds(): [number, number, number, number] | null {
        return this.latestReducedBounds;
    }

    update(
        camera: Camera,
        overlayBounds: readonly [number, number, number, number],
        overlayUvRect: readonly [number, number, number, number],
        waterColor: readonly [number, number, number],
        options: TerrainDebugOptions = {},
    ): void {
        const uniform = new Float32Array(48);
        uniform.set(camera.getViewProjectionMatrix(), 0);
        uniform.set([...camera.getEye(), 1], 16);
        uniform.set([0.42, -0.46, -0.78, 0], 20);
        uniform.set([performance.now() / 1000, MAX_LOD_LEVEL + 1, Math.min(this.source.cellSizeX, this.source.cellSizeY), PATCH_CELLS], 24);
        uniform.set([this.source.originX, this.source.originY, this.source.cellSizeX, this.source.cellSizeY], 28);
        uniform.set([this.source.width, this.source.height, this.source.minHeight, this.source.maxHeight], 32);
        uniform.set([overlayBounds[0], overlayBounds[1], overlayBounds[2] - overlayBounds[0], overlayBounds[3] - overlayBounds[1]], 36);
        uniform.set(overlayUvRect, 40);
        uniform.set([waterColor[0], waterColor[1], waterColor[2], 0.08], 44);
        this.device.queue.writeBuffer(this.cameraBuffer, 0, uniform);

        if (!options.freezeLod || this.lastBlocks.length === 0) {
            this.selectBlocks(camera, options.enableCulling !== false);
        }

        this.instanceCount = Math.min(this.lastBlocks.length, MAX_INSTANCES);
        for (let i = 0; i < this.instanceCount; i += 1) {
            const block = this.lastBlocks[i];
            const offset = i * 8;
            this.instanceData[offset] = block.x;
            this.instanceData[offset + 1] = block.y;
            this.instanceData[offset + 2] = block.size;
            this.instanceData[offset + 3] = block.level;
            this.instanceData[offset + 4] = block.seamXMin;
            this.instanceData[offset + 5] = block.seamXMax;
            this.instanceData[offset + 6] = block.seamYMin;
            this.instanceData[offset + 7] = block.seamYMax;
        }
        this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instanceData.subarray(0, this.instanceCount * 8));
        this.stats.selectedBlocks = this.instanceCount;
        this.stats.triangles = (this.mesh.indexCount / 3) * this.instanceCount;
    }

    render(pass: GPURenderPassEncoder, showMesh = false): void {
        if (this.instanceCount === 0) {
            return;
        }

        pass.setBindGroup(0, this.bindGroup);
        pass.setVertexBuffer(0, this.mesh.vertexBuffer);
        pass.setVertexBuffer(1, this.instanceBuffer);
        pass.setPipeline(this.pipeline);
        pass.setIndexBuffer(this.mesh.indexBuffer, 'uint32');
        pass.drawIndexed(this.mesh.indexCount, this.instanceCount);

        if (showMesh) {
            pass.setPipeline(this.meshPipeline);
            pass.setIndexBuffer(this.mesh.lineIndexBuffer, 'uint32');
            pass.drawIndexed(this.mesh.lineIndexCount, this.instanceCount);
        }
    }

    renderDepth(pass: GPURenderPassEncoder): void {
        if (this.instanceCount === 0) {
            return;
        }

        pass.setBindGroup(0, this.bindGroup);
        pass.setVertexBuffer(0, this.mesh.vertexBuffer);
        pass.setVertexBuffer(1, this.instanceBuffer);
        pass.setPipeline(this.depthPipeline);
        pass.setIndexBuffer(this.mesh.indexBuffer, 'uint32');
        pass.drawIndexed(this.mesh.indexCount, this.instanceCount);
    }

    encodeVisibleBoundsReduction(encoder: GPUCommandEncoder): void {
        if (this.instanceCount === 0) {
            return;
        }

        const renderPass = encoder.beginRenderPass({
            label: 'Terrain visible bounds prepass',
            colorAttachments: [
                {
                    view: this.visibleBoundsTextureView,
                    clearValue: { r: 65504, g: 65504, b: -65504, a: -65504 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: this.visibleBoundsDepthTextureView,
                depthClearValue: 0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.setVertexBuffer(0, this.mesh.vertexBuffer);
        renderPass.setVertexBuffer(1, this.instanceBuffer);
        renderPass.setPipeline(this.visibleBoundsPipeline);
        renderPass.setIndexBuffer(this.mesh.indexBuffer, 'uint32');
        renderPass.drawIndexed(this.mesh.indexCount, this.instanceCount);
        renderPass.end();

        const computePass = encoder.beginComputePass({ label: 'Terrain visible bounds reduction' });
        computePass.setPipeline(this.reduceTexturePipeline);
        computePass.setBindGroup(0, this.reduceTextureBindGroup);
        computePass.dispatchWorkgroups(BOUNDS_PASS_1_COUNT);
        computePass.setPipeline(this.reduceBufferPipeline);
        computePass.setBindGroup(1, this.reducePass2BindGroup);
        computePass.dispatchWorkgroups(BOUNDS_PASS_2_COUNT);
        computePass.setBindGroup(1, this.reducePass3BindGroup);
        computePass.dispatchWorkgroups(BOUNDS_PASS_3_COUNT);
        computePass.end();

        if (!this.boundsReadbackPending && !this.boundsReadbackInFlight) {
            encoder.copyBufferToBuffer(
                this.reduceFinal,
                0,
                this.reduceReadback,
                0,
                4 * Float32Array.BYTES_PER_ELEMENT,
            );
            this.boundsReadbackPending = true;
        }
    }

    resolveVisibleBoundsReadback(): void {
        if (!this.boundsReadbackPending || this.boundsReadbackInFlight) {
            return;
        }

        this.boundsReadbackPending = false;
        this.boundsReadbackInFlight = true;
        this.reduceReadback.mapAsync(GPUMapMode.READ).then(() => {
            const values = new Float32Array(this.reduceReadback.getMappedRange().slice(0));
            this.reduceReadback.unmap();
            this.boundsReadbackInFlight = false;

            const [minX, minY, maxX, maxY] = values;
            if (
                Number.isFinite(minX) &&
                Number.isFinite(minY) &&
                Number.isFinite(maxX) &&
                Number.isFinite(maxY) &&
                minX <= maxX &&
                minY <= maxY
            ) {
                this.latestReducedBounds = [minX, minY, maxX, maxY];
            }
        }).catch((error: unknown) => {
            this.boundsReadbackInFlight = false;
            console.warn('Terrain visible bounds readback failed:', error);
        });
    }


    renderOverlayBounds(
        pass: GPURenderPassEncoder,
        bounds: readonly [number, number, number, number],
        cameraPosition?: readonly [number, number],
    ): void {
        const z = this.source.maxHeight + 20;
        const [minX, minY, maxX, maxY] = bounds;
        const values = [
            minX, minY, z, maxX, minY, z,
            maxX, minY, z, maxX, maxY, z,
            maxX, maxY, z, minX, maxY, z,
            minX, maxY, z, minX, minY, z,
        ];
        if (cameraPosition) {
            const markerSize = Math.max(maxX - minX, maxY - minY) * 0.025;
            const [x, y] = cameraPosition;
            values.push(
                x - markerSize, y, z, x + markerSize, y, z,
                x, y - markerSize, z, x, y + markerSize, z,
            );
        }
        const vertices = new Float32Array(values);

        this.device.queue.writeBuffer(this.boundsVertexBuffer, 0, vertices);
        pass.setBindGroup(0, this.bindGroup);
        pass.setPipeline(this.boundsPipeline);
        pass.setVertexBuffer(0, this.boundsVertexBuffer);
        pass.draw(vertices.length / 3);
    }

    destroy(): void {
        this.heightTexture.destroy();
        this.visibleBoundsTexture.destroy();
        this.visibleBoundsDepthTexture.destroy();
        this.mesh.vertexBuffer.destroy();
        this.mesh.indexBuffer.destroy();
        this.mesh.lineIndexBuffer.destroy();
        this.cameraBuffer.destroy();
        this.instanceBuffer.destroy();
        this.boundsVertexBuffer.destroy();
        this.reduceParamsTextureBuffer.destroy();
        this.reduceParamsPass2Buffer.destroy();
        this.reduceParamsPass3Buffer.destroy();
        this.reducePartialA.destroy();
        this.reducePartialB.destroy();
        this.reduceFinal.destroy();
        this.reduceReadback.destroy();
    }

    private selectBlocks(camera: Camera, enableCulling: boolean): void {
        const viewProjection = camera.getViewProjectionMatrix();
        const planes = extractFrustumPlanes(viewProjection);
        const viewportHeight = Math.max(camera.getViewportHeight(), 1);
        const projectionScale = viewportHeight / (2 * Math.tan(camera.getFovyRadians() / 2));
        const [minX, minY, maxX, maxY] = this.bounds;
        const terrainSize = Math.max(maxX - minX, maxY - minY);
        const rootSize = nextPowerOfTwo(terrainSize);
        const rootLevel = Math.min(MAX_LOD_LEVEL, Math.max(0, Math.ceil(Math.log2(rootSize / (PATCH_CELLS * Math.min(this.source.cellSizeX, this.source.cellSizeY))))));
        const stack: BlockCandidate[] = [createBlock(minX, minY, rootSize, rootLevel)];
        const blocks: BlockCandidate[] = [];

        this.stats.culledBlocks = 0;
        while (stack.length > 0 && blocks.length < MAX_INSTANCES) {
            const block = stack.pop()!;
            if (!rangesOverlap(block.x, block.x + block.size, minX, maxX) || !rangesOverlap(block.y, block.y + block.size, minY, maxY)) {
                continue;
            }
            if (enableCulling && !blockIntersectsFrustum(block, planes, this.source.minHeight, this.source.maxHeight)) {
                this.stats.culledBlocks += 1;
                continue;
            }
            if (shouldSplitBlock(block, camera, projectionScale, Math.min(this.source.cellSizeX, this.source.cellSizeY))) {
                const childSize = block.size * 0.5;
                const childLevel = block.level - 1;
                stack.push(
                    createBlock(block.x, block.y, childSize, childLevel),
                    createBlock(block.x + childSize, block.y, childSize, childLevel),
                    createBlock(block.x, block.y + childSize, childSize, childLevel),
                    createBlock(block.x + childSize, block.y + childSize, childSize, childLevel),
                );
            } else {
                blocks.push(block);
            }
        }
        this.lastBlocks.length = 0;
        this.lastBlocks.push(...blocks.sort((a, b) => a.level - b.level));
    }
}

function createPatchMesh(device: GPUDevice): TerrainMesh {
    const vertices: number[] = [];
    for (let y = 0; y <= PATCH_CELLS; y += 1) {
        for (let x = 0; x <= PATCH_CELLS; x += 1) {
            vertices.push(x / PATCH_CELLS, y / PATCH_CELLS, 0);
        }
    }

    const indices: number[] = [];
    for (let y = 0; y < PATCH_CELLS; y += 1) {
        for (let x = 0; x < PATCH_CELLS; x += 1) {
            const i0 = gridIndex(x, y);
            const i1 = gridIndex(x + 1, y);
            const i2 = gridIndex(x, y + 1);
            const i3 = gridIndex(x + 1, y + 1);
            indices.push(i0, i2, i1, i1, i2, i3);
        }
    }

    const lineIndices = createLineIndices();
    const vertexData = new Float32Array(vertices);
    const indexData = new Uint32Array(indices);
    const lineIndexData = new Uint32Array(lineIndices);
    const vertexBuffer = device.createBuffer({ label: 'Terrain patch vertices', size: vertexData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const indexBuffer = device.createBuffer({ label: 'Terrain patch indices', size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    const lineIndexBuffer = device.createBuffer({ label: 'Terrain patch line indices', size: lineIndexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertexBuffer, 0, vertexData);
    device.queue.writeBuffer(indexBuffer, 0, indexData);
    device.queue.writeBuffer(lineIndexBuffer, 0, lineIndexData);

    return { vertexBuffer, indexBuffer, lineIndexBuffer, indexCount: indexData.length, lineIndexCount: lineIndexData.length };
}

function createLineIndices(): number[] {
    const indices: number[] = [];
    for (let y = 0; y <= PATCH_CELLS; y += 1) {
        for (let x = 0; x < PATCH_CELLS; x += 1) {
            indices.push(gridIndex(x, y), gridIndex(x + 1, y));
        }
    }
    for (let x = 0; x <= PATCH_CELLS; x += 1) {
        for (let y = 0; y < PATCH_CELLS; y += 1) {
            indices.push(gridIndex(x, y), gridIndex(x, y + 1));
        }
    }
    return indices;
}

function gridIndex(x: number, y: number): number {
    return y * PATCH_VERTICES + x;
}

function createBlock(x: number, y: number, size: number, level: number): BlockCandidate {
    return { x, y, size, level, seamXMin: 0, seamXMax: 0, seamYMin: 0, seamYMax: 0 };
}

function shouldSplitBlock(block: BlockCandidate, camera: Camera, projectionScale: number, baseCellSize: number): boolean {
    if (block.level === 0) {
        return false;
    }
    const eye = camera.getEye();
    const lookAt = camera.getLookAt();
    const distance = Math.max(1, Math.min(distanceToBlock3d(eye[0], eye[1], eye[2], block), distanceToBlock3d(lookAt[0], lookAt[1], lookAt[2], block)));
    const cellSize = baseCellSize * 2 ** block.level;
    return (cellSize * projectionScale) / distance > TARGET_CELL_PIXELS;
}

function distanceToBlock3d(x: number, y: number, z: number, block: BlockCandidate): number {
    const dx = Math.max(block.x - x, 0, x - (block.x + block.size));
    const dy = Math.max(block.y - y, 0, y - (block.y + block.size));
    return Math.hypot(dx, dy, Math.abs(z - TERRAIN_LOD_REFERENCE_HEIGHT));
}

function blockIntersectsFrustum(block: BlockCandidate, planes: Plane[], minHeight: number, maxHeight: number): boolean {
    for (const plane of planes) {
        const px = plane[0] >= 0 ? block.x + block.size : block.x;
        const py = plane[1] >= 0 ? block.y + block.size : block.y;
        const pz = plane[2] >= 0 ? maxHeight : minHeight;
        if (plane[0] * px + plane[1] * py + plane[2] * pz + plane[3] < 0) {
            return false;
        }
    }
    return true;
}

function extractFrustumPlanes(matrix: Float32Array): Plane[] {
    return [
        normalizePlane([matrix[3] + matrix[0], matrix[7] + matrix[4], matrix[11] + matrix[8], matrix[15] + matrix[12]]),
        normalizePlane([matrix[3] - matrix[0], matrix[7] - matrix[4], matrix[11] - matrix[8], matrix[15] - matrix[12]]),
        normalizePlane([matrix[3] + matrix[1], matrix[7] + matrix[5], matrix[11] + matrix[9], matrix[15] + matrix[13]]),
        normalizePlane([matrix[3] - matrix[1], matrix[7] - matrix[5], matrix[11] - matrix[9], matrix[15] - matrix[13]]),
        normalizePlane([matrix[2], matrix[6], matrix[10], matrix[14]]),
        normalizePlane([matrix[3] - matrix[2], matrix[7] - matrix[6], matrix[11] - matrix[10], matrix[15] - matrix[14]]),
    ];
}

function normalizePlane(plane: Plane): Plane {
    const length = Math.hypot(plane[0], plane[1], plane[2]) || 1;
    return [plane[0] / length, plane[1] / length, plane[2] / length, plane[3] / length];
}

function rangesOverlap(minA: number, maxA: number, minB: number, maxB: number): boolean {
    return minA < maxB && minB < maxA;
}

function nextPowerOfTwo(value: number): number {
    return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

function createStorageBuffer(device: GPUDevice, vec4Count: number, label: string): GPUBuffer {
    return device.createBuffer({
        label,
        size: Math.max(1, vec4Count) * 4 * Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
}

function createReduceParamsBuffer(device: GPUDevice, total: number, width: number, height: number): GPUBuffer {
    const data = new Uint32Array([total, width, height, 0]);
    const buffer = device.createBuffer({
        label: 'Terrain bounds reduce params',
        size: data.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
}
