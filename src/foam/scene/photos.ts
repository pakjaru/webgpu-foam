import { createBufferWithData } from '../../webgpu/utils';

// Photos (public/images, webp). Each goes into one square texture array
// layer; its real aspect is kept separately for cover-cropping in the shader.
export const PHOTOS = Array.from({ length: 13 }, (_, i) => `/images/${String(i).padStart(2, '0')}.webp`);
const LAYER_SIZE = 1024;

/** Uploads every photo into one texture array, plus a storage buffer of their aspects (width / height). */
export async function loadPhotos(device: GPUDevice) {
  const bitmaps = await Promise.all(PHOTOS.map(async (url) => createImageBitmap(await (await fetch(url)).blob())));
  const texture = device.createTexture({
    size: [LAYER_SIZE, LAYER_SIZE, PHOTOS.length],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  for (const [z, bitmap] of bitmaps.entries()) {
    const square = await createImageBitmap(bitmap, { resizeWidth: LAYER_SIZE, resizeHeight: LAYER_SIZE, resizeQuality: 'high' });
    device.queue.copyExternalImageToTexture({ source: square }, { texture, origin: [0, 0, z] }, [LAYER_SIZE, LAYER_SIZE]);
    await new Promise((r) => setTimeout(r)); // one upload per task keeps the main thread responsive
  }
  const aspects = createBufferWithData(device, 'aspects', new Float32Array(bitmaps.map((b) => b.width / b.height)), GPUBufferUsage.STORAGE);
  return { texture, aspects };
}
