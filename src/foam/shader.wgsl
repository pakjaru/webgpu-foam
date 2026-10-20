// Scene pass: one shared vertex transform for every element, an (N+1)^2 grid
// of uvs instanced per element. Page elements sit at their DOM layout; ring
// elements (`ring` = 1) are fins of the about fan.
struct U {
  viewProj: mat4x4f,
  viewport: vec2f,
  scroll: f32,
  spin: f32,     // fan rotation, radians
  count: f32, // instances in the fan
  wire: f32,  // 1 for the wire layer: nudged toward the camera so it wins depth
  ring: f32,  // 1 = place as a fan fin, 0 = place at DOM layout
  spinVel: f32,  // fan angular velocity, rad/s (drives the wave)
  mouse: vec2f,   // smoothed cursor, document px
  hover: f32,     // cursor presence 0..1 (fades out when it leaves the page)
  lift: f32,      // 1 = this draw reacts to the cursor (photos), 0 = it doesn't
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;
// Photos: one array layer each, squashed to a square; `aspects` holds each
// photo's real width / height so cover-cropping can undo the squash.
@group(0) @binding(3) var images: texture_2d_array<f32>;
@group(0) @binding(4) var<uniform> slide: vec4f; // work: current layer, next layer, progress 0..1
@group(0) @binding(5) var<storage, read> aspects: array<f32>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) uv: vec2f,
  @location(2) atlasUv: vec2f,
  @location(3) docY: f32,  // document-space y, for the split-text line mask
  @location(4) clipY: f32, // fragments below this doc y are discarded
  @location(5) @interpolate(flat) img: f32, // photo layer, -1 = flat colour (work: element aspect)
  @location(6) bulge: f32, // cursor influence at this vertex, 0..1
}

const BULGE_RADIUS = 220.0; // px
const BULGE_LIFT = 70.0;    // px toward the camera at the cursor

/** object-fit: cover: uv into a photo of aspect `img` filling a box of aspect `box`. */
fn cover(uv: vec2f, box: f32, img: f32) -> vec2f {
  let r = box / img;
  let scale = select(vec2f(1.0, 1.0 / r), vec2f(r, 1.0), r < 1.0);
  return (uv - 0.5) * scale + 0.5;
}

const PI = 3.14159265;
// Fan fins: size, and how far each spine sits from the axis (more = more room between fins).
const FIN_W = 180.0;
const FIN_H = 240.0;
const FIN_GAP = 90.0;

fn place(uv: vec2f, rect: vec4f, color: vec4f, index: f32) -> Out {
  // Page layout: document px -> world px, origin at viewport centre, y up.
  // Nested layers (color.w = depth) sit slightly in front of their parents.
  let px = rect.xy + uv * rect.zw - vec2f(0.0, u.scroll);
  var page = vec3f(px.x - u.viewport.x * 0.5, u.viewport.y * 0.5 - px.y, color.w * 4.0);

  // Cursor bulge: the subdivided pane swells toward the camera under the
  // cursor, like a soft membrane being pressed from behind.
  let d = distance(rect.xy + uv * rect.zw, u.mouse);
  let bulge = exp(-(d * d) / (BULGE_RADIUS * BULGE_RADIUS)) * u.hover * u.lift * (1.0 - u.ring);
  page.z += bulge * BULGE_LIFT;

  // Fan: each card is a tilted fin radiating from the Y axis, keeping its aspect.
  // Waving: the faster the fan spins, the more each fin's outer edge lags
  // behind its spine, with a ripple running down its height, like cloth.
  let lag = clamp(u.spinVel, -4.0, 4.0);
  let tip = (uv.x * uv.x); // 0 at the spine, 1 at the outer edge
  let flutter = sin(uv.y * 6.0 - u.spin * 4.0 + index) * abs(lag) * 0.03;
  let a = index / max(u.count, 1.0) * 2.0 * PI + u.spin - tip * (lag * 0.08 + flutter);
  // Every fin is the same size; photos cover-crop into it.
  let card = vec2f(FIN_W, FIN_H);
  let local = (uv - 0.5) * vec2f(card.x, -card.y);
  let dir = vec3f(sin(a), 0.0, cos(a));
  let radial = FIN_GAP + local.x + card.x * 0.5;
  let fin = dir * radial + vec3f(0.0, local.y - radial * 0.35, 0.0);
  // Tip the whole fan toward the camera so it reads as a fan, not a wall.
  let c = cos(0.45);
  let s = sin(0.45);
  let ring = vec3f(fin.x, fin.y * c - fin.z * s, fin.y * s + fin.z * c);

  var o: Out;
  o.pos = u.viewProj * vec4f(mix(page, ring, u.ring), 1.0);
  o.pos.z -= u.wire * 0.0005 * o.pos.w;
  o.color = color.rgb;
  o.uv = uv;
  o.docY = rect.y + uv.y * rect.w;
  o.clipY = 1e9;
  o.img = -1.0;
  o.bulge = bulge;
  return o;
}

/** Magnify toward the swell: uvs shrink around the centre where the bulge is. */
fn lens(uv: vec2f, bulge: f32) -> vec2f {
  return (uv - 0.5) * (1.0 - 0.16 * bulge) + 0.5;
}

@vertex
fn vs(
  @location(0) uv: vec2f,
  @location(1) rect: vec4f,
  @location(2) color: vec4f,
  @location(6) img: f32,
  @builtin(instance_index) ii: u32,
) -> Out {
  var o = place(uv, rect, color, f32(ii));
  o.img = img;
  if (img >= 0.0) { o.atlasUv = lens(cover(uv, rect.z / rect.w, aspects[u32(img)]), o.bulge); }
  return o;
}

@vertex
fn vs_text(
  @location(0) uv: vec2f,
  @location(1) rect: vec4f,
  @location(2) color: vec4f,
  @location(3) atlasRect: vec4f,
  @location(4) lineBottom: f32,
  @location(5) reveal: f32, // split-text progress 0..1 (eased on the CPU)
  @builtin(instance_index) ii: u32,
) -> Out {
  // Slide up from below its line; the line's bottom edge masks it.
  var r = rect;
  r.y += (lineBottom - rect.y) * (1.0 - reveal);
  var o = place(uv, r, color, f32(ii));
  o.atlasUv = mix(atlasRect.xy, atlasRect.zw, uv);
  o.clipY = lineBottom;
  return o;
}

@fragment
fn fs_solid(i: Out) -> @location(0) vec4f {
  // Sample unconditionally: textureSample needs uniform control flow.
  let photo = textureSample(images, atlasSampler, i.atlasUv, i32(max(i.img, 0.0))).rgb * (1.0 + 0.12 * i.bulge);
  let shade = 0.85 + 0.15 * (1.0 - i.uv.y);
  return vec4f(select(i.color * shade, photo, i.img >= 0.0), 1.0);
}

@fragment
fn fs_text(i: Out) -> @location(0) vec4f {
  // Sample before discarding: textureSample needs uniform control flow.
  let a = textureSample(atlas, atlasSampler, i.atlasUv).a;
  if (i.docY > i.clipY - 0.5) { discard; }
  return vec4f(i.color, a);
}

@fragment
fn fs_wire(i: Out) -> @location(0) vec4f {
  if (i.docY > i.clipY - 0.5) { discard; }
  return vec4f(0.05, 0.05, 0.05, 1.0);
}

@vertex
fn vs_image(
  @location(0) uv: vec2f,
  @location(1) rect: vec4f,
  @location(2) color: vec4f,
  @builtin(instance_index) ii: u32,
) -> Out {
  var o = place(uv, rect, color, f32(ii));
  o.img = rect.z / rect.w; // element aspect; each layer is cover-cropped in fs_image
  return o;
}

@fragment
fn fs_image(i: Out) -> @location(0) vec4f {
  // The next slide rises from the bottom edge, settling from a slight zoom,
  // while the current one drifts up and darkens underneath it.
  let k = slide.z;
  let e = k * k * (3.0 - 2.0 * k);
  let luv = lens(i.uv, i.bulge * 0.6);
  let curUv = cover(luv, i.img, aspects[u32(slide.x)]) - vec2f(0.0, e * 0.12);
  let nextUv = (cover(luv, i.img, aspects[u32(slide.y)]) - 0.5) * (1.0 - 0.12 * (1.0 - e)) + 0.5 + vec2f(0.0, (1.0 - e) * 0.12);
  let cur = textureSample(images, atlasSampler, curUv, i32(slide.x)).rgb * (1.0 - 0.5 * e);
  let next = textureSample(images, atlasSampler, nextUv, i32(slide.y)).rgb;
  // Darken toward the bottom so the white title reads on bright photos.
  let scrim = mix(1.0, 0.45, smoothstep(0.35, 1.0, i.uv.y));
  return vec4f(select(cur, next, i.uv.y > 1.0 - e) * scrim, 1.0);
}
