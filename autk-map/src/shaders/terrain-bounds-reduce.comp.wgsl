struct Params {
  total: u32,
  width: u32,
  height: u32,
  _pad: u32,
};

struct BoundsBuffer {
  values: array<vec4<f32>>,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outputBuffer: BoundsBuffer;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var<storage, read> inputBuffer: BoundsBuffer;
@group(1) @binding(1) var<storage, read_write> nextOutputBuffer: BoundsBuffer;
@group(1) @binding(2) var<uniform> bufferParams: Params;

var<workgroup> partial: array<vec4<f32>, 256>;

fn emptyBounds() -> vec4<f32> {
  return vec4<f32>(1.0e20, 1.0e20, -1.0e20, -1.0e20);
}

fn mergeBounds(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(min(a.x, b.x), min(a.y, b.y), max(a.z, b.z), max(a.w, b.w));
}

@compute @workgroup_size(256)
fn reduceTexture(
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>,
) {
  let localIndex = localId.x;
  let globalIndex = workgroupId.x * 256u + localIndex;
  var value = emptyBounds();

  if (globalIndex < params.total) {
    let x = i32(globalIndex % params.width);
    let y = i32(globalIndex / params.width);
    value = textureLoad(inputTexture, vec2<i32>(x, y), 0);
  }

  partial[localIndex] = value;
  workgroupBarrier();

  var stride = 128u;
  loop {
    if (stride == 0u) {
      break;
    }
    if (localIndex < stride) {
      partial[localIndex] = mergeBounds(partial[localIndex], partial[localIndex + stride]);
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (localIndex == 0u) {
    outputBuffer.values[workgroupId.x] = partial[0];
  }
}

@compute @workgroup_size(256)
fn reduceBuffer(
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>,
) {
  let localIndex = localId.x;
  let globalIndex = workgroupId.x * 256u + localIndex;
  var value = emptyBounds();

  if (globalIndex < bufferParams.total) {
    value = inputBuffer.values[globalIndex];
  }

  partial[localIndex] = value;
  workgroupBarrier();

  var stride = 128u;
  loop {
    if (stride == 0u) {
      break;
    }
    if (localIndex < stride) {
      partial[localIndex] = mergeBounds(partial[localIndex], partial[localIndex + stride]);
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (localIndex == 0u) {
    nextOutputBuffer.values[workgroupId.x] = partial[0];
  }
}
