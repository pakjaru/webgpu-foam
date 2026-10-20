import { STRIDE } from '../lib/dom_compiler';
import { PHOTOS } from './photos';

export const FAN_CARDS = 13; // one fin per photo

/** About fan fins: equal 180x240 cards (the shader places and sizes them; the rect only drives the photo crop). */
export function fanCards(): Float32Array<ArrayBuffer> {
  const out = new Float32Array(FAN_CARDS * STRIDE);
  for (let i = 0; i < FAN_CARDS; i++) out.set([0, 0, 180, 240, 0.5, 0.5, 0.5, 0], i * STRIDE);
  return out;
}

/** Photo layer per fin: they cycle through every photo. */
export const fanPhotos = () => Float32Array.from({ length: FAN_CARDS }, (_, i) => i % PHOTOS.length);
