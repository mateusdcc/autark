export const terrainShader = /* wgsl */ `
struct CameraUniform {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  lightDirection: vec4<f32>,
  settings: vec4<f32>,
  heightOriginCell: vec4<f32>,
  heightDims: vec4<f32>,
  overlayBounds: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) level: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var heightFieldTexture: texture_2d<f32>;
@group(0) @binding(2) var overlaySampler: sampler;
@group(0) @binding(3) var overlayTexture: texture_2d<f32>;

fn terrainHeight(xy: vec2<f32>) -> f32 {
  let origin = camera.heightOriginCell.xy;
  let cellSize = camera.heightOriginCell.zw;
  let dims = vec2<i32>(i32(camera.heightDims.x), i32(camera.heightDims.y));
  let texel = clamp((xy - origin) / cellSize, vec2<f32>(0.0), vec2<f32>(f32(dims.x - 2), f32(dims.y - 2)));
  let base = vec2<i32>(floor(texel));
  let blend = fract(texel);
  let h00 = textureLoad(heightFieldTexture, base, 0).r;
  let h10 = textureLoad(heightFieldTexture, base + vec2<i32>(1, 0), 0).r;
  let h01 = textureLoad(heightFieldTexture, base + vec2<i32>(0, 1), 0).r;
  let h11 = textureLoad(heightFieldTexture, base + vec2<i32>(1, 1), 0).r;

  return mix(mix(h00, h10, blend.x), mix(h01, h11, blend.x), blend.y);
}

fn insideUnit(uv: vec2<f32>) -> bool {
  return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;
}

fn overlayColor(xy: vec2<f32>) -> vec4<f32> {
  let uv = (xy - camera.overlayBounds.xy) / camera.overlayBounds.zw;
  if (!insideUnit(uv)) {
    return vec4<f32>(0.0);
  }

  return textureSample(overlayTexture, overlaySampler, vec2<f32>(uv.x, 1.0 - uv.y));
}

fn inOverlayBounds(xy: vec2<f32>) -> bool {
  let uv = (xy - camera.overlayBounds.xy) / camera.overlayBounds.zw;
  return insideUnit(uv);
}

fn terrainNormal(xy: vec2<f32>, sampleDistance: f32) -> vec3<f32> {
  let d = max(sampleDistance, 1.0);
  let hL = terrainHeight(xy - vec2<f32>(d, 0.0));
  let hR = terrainHeight(xy + vec2<f32>(d, 0.0));
  let hD = terrainHeight(xy - vec2<f32>(0.0, d));
  let hU = terrainHeight(xy + vec2<f32>(0.0, d));
  return normalize(vec3<f32>(hL - hR, hD - hU, 2.0 * d));
}

fn lodDebugColor(level: f32) -> vec3<f32> {
  let lod = i32(round(level));
  if (lod == 0) { return vec3<f32>(1.00, 0.10, 0.10); }
  if (lod == 1) { return vec3<f32>(1.00, 0.55, 0.00); }
  if (lod == 2) { return vec3<f32>(1.00, 0.95, 0.00); }
  if (lod == 3) { return vec3<f32>(0.20, 0.90, 0.20); }
  if (lod == 4) { return vec3<f32>(0.00, 0.85, 1.00); }
  if (lod == 5) { return vec3<f32>(0.15, 0.35, 1.00); }
  if (lod == 6) { return vec3<f32>(0.65, 0.25, 1.00); }
  return vec3<f32>(1.00, 0.20, 0.85);
}

@vertex
fn vertexMain(
  @location(0) localPosition: vec2<f32>,
  @location(1) levelData: vec4<f32>,
  @location(2) unused: f32,
  @location(3) seamData: vec4<f32>,
) -> VertexOutput {
  _ = unused;
  _ = seamData;
  let blockOrigin = levelData.xy;
  let blockSize = levelData.z;
  let level = levelData.w;
  let scale = blockSize / camera.settings.w;
  let worldXY = blockOrigin + localPosition * blockSize;
  let height = terrainHeight(worldXY);
  let worldPosition = vec3<f32>(worldXY.x, worldXY.y, height);

  var output: VertexOutput;
  output.clipPosition = camera.viewProjection * vec4<f32>(worldPosition, 1.0);
  output.worldPosition = worldPosition;
  output.normal = terrainNormal(worldXY, scale);
  output.level = level;
  return output;
}

@vertex
fn meshVertexMain(
  @location(0) localPosition: vec2<f32>,
  @location(1) levelData: vec4<f32>,
  @location(2) unused: f32,
  @location(3) seamData: vec4<f32>,
) -> VertexOutput {
  _ = unused;
  _ = seamData;
  let blockOrigin = levelData.xy;
  let blockSize = levelData.z;
  let level = levelData.w;
  let scale = blockSize / camera.settings.w;
  let worldXY = blockOrigin + localPosition * blockSize;
  let height = terrainHeight(worldXY);
  let normal = terrainNormal(worldXY, scale);
  let worldPosition = vec3<f32>(worldXY.x, worldXY.y, height) + normal * max(0.6, scale * 0.08);

  var output: VertexOutput;
  output.clipPosition = camera.viewProjection * vec4<f32>(worldPosition, 1.0);
  output.worldPosition = worldPosition;
  output.normal = normal;
  output.level = level;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  if (!inOverlayBounds(input.worldPosition.xy)) {
    discard;
  }

  let overlay = overlayColor(input.worldPosition.xy);
  if (overlay.a <= 0.001) {
    discard;
  }

  return vec4<f32>(overlay.rgb * overlay.a, overlay.a);
}

@fragment
fn meshFragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(lodDebugColor(input.level), 1.0);
}
`;
