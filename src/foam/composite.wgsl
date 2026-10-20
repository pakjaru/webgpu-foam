// Composite pass: each route renders to its own texture; this mixes them with
// a circle that grows from the centre, revealing `to` over `from`. The rim
// refracts (pulls uvs inward), splits RGB and catches a white highlight.
struct C {
  p: f32,      // reveal progress 0..1
  aspect: f32, // width / height
  time: f32,
  _pad: f32,
}
@group(0) @binding(0) var<uniform> c: C;
@group(0) @binding(1) var fromTex: texture_2d<f32>;
@group(0) @binding(2) var toTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> Out {
  // Fullscreen triangle.
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: Out;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}

const PI = 3.14159265;

// Splits one scene into RGB, each channel displaced a little further along
// `off` than the last: chromatic aberration.
fn aberrate(tex: texture_2d<f32>, uv: vec2f, off: vec2f) -> vec3f {
  return vec3f(
    textureSample(tex, samp, uv - off * 1.4).r,
    textureSample(tex, samp, uv - off).g,
    textureSample(tex, samp, uv - off * 0.6).b,
  );
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  let q = (i.uv - 0.5) * vec2f(c.aspect, 1.0);
  let dist = length(q);
  let dir = q / max(dist, 1e-4);

  // Radius: slow start, fast middle, long settle (expo in-out), ending past
  // the farthest corner.
  let p = c.p;
  let e = select(1.0 - pow(2.0, -20.0 * p + 10.0) * 0.5, pow(2.0, 20.0 * p - 10.0) * 0.5, p < 0.5);
  let maxR = length(vec2f(c.aspect * 0.5, 0.5)) + 0.15;
  let alive = sin(p * PI); // 0 at rest, so nothing distorts when idle
  let x = dist - e * maxR; // < 0 inside the circle

  // Depth: the outgoing scene sinks away (zooms out, dims) while the incoming
  // one settles from a slight zoom, so the reveal reads as moving forward.
  let fromUv = (i.uv - 0.5) * (1.0 + 0.08 * e) + 0.5;
  let toUv = (i.uv - 0.5) * (1.0 - 0.1 * (1.0 - e)) + 0.5;

  // Lens push: one smooth lobe on the front bends content outward, and the
  // RGB split rides the same lobe so colour fringes hug the edge.
  let w = 0.16;
  let push = exp(-(x * x) / (w * w)) * alive;
  let off = dir * push * 0.08 / vec2f(c.aspect, 1.0);
  let toCol = aberrate(toTex, toUv, off);
  let fromCol = aberrate(fromTex, fromUv, off * 0.5) * (1.0 - 0.3 * e);

  // Soft feathered edge with a thin highlight just inside it.
  let inside = 1.0 - smoothstep(-0.012, 0.004, x);
  let rim = exp(-abs(x + 0.006) * 60.0) * alive;
  let col = mix(fromCol, toCol, inside) + vec3f(rim * 0.22);
  return vec4f(min(col, vec3f(1.0)), 1.0);
}
