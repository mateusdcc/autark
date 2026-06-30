struct CameraUniform {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  lightDirection: vec4<f32>,
  settings: vec4<f32>,
  heightOriginCell: vec4<f32>,
  heightDims: vec4<f32>,
  overlayBounds: vec4<f32>,
  overlayUvRect: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) level: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var heightFieldTexture: texture_2d<f32>;

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

fn terrainNormal(xy: vec2<f32>, sampleDistance: f32) -> vec3<f32> {
  let d = max(sampleDistance, 1.0);
  let hL = terrainHeight(xy - vec2<f32>(d, 0.0));
  let hR = terrainHeight(xy + vec2<f32>(d, 0.0));
  let hD = terrainHeight(xy - vec2<f32>(0.0, d));
  let hU = terrainHeight(xy + vec2<f32>(0.0, d));
  return normalize(vec3<f32>(hL - hR, hD - hU, 2.0 * d));
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

@vertex
fn boundsVertexMain(@location(0) position: vec3<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProjection * vec4<f32>(position, 1.0);
  output.worldPosition = position;
  output.normal = vec3<f32>(0.0, 0.0, 1.0);
  output.level = 0.0;
  return output;
}

@vertex
fn visibleBoundsVertexMain(
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
