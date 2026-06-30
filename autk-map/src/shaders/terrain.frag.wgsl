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
@group(0) @binding(2) var overlaySampler: sampler;
@group(0) @binding(3) var overlayTexture: texture_2d<f32>;

fn insideUnit(uv: vec2<f32>) -> bool {
  return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;
}

fn overlayColor(xy: vec2<f32>) -> vec4<f32> {
  let uv = (xy - camera.overlayBounds.xy) / camera.overlayBounds.zw;
  if (!insideUnit(uv)) {
    return vec4<f32>(0.0);
  }

  let atlasUv = camera.overlayUvRect.xy + vec2<f32>(uv.x, 1.0 - uv.y) * camera.overlayUvRect.zw;
  return textureSample(overlayTexture, overlaySampler, atlasUv);
}

fn inOverlayBounds(xy: vec2<f32>) -> bool {
  let uv = (xy - camera.overlayBounds.xy) / camera.overlayBounds.zw;
  return insideUnit(uv);
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

@fragment
fn boundsFragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  _ = input;
  return vec4<f32>(1.0, 1.0, 0.0, 1.0);
}

@fragment
fn visibleBoundsFragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.worldPosition.x, input.worldPosition.y, input.worldPosition.x, input.worldPosition.y);
}
