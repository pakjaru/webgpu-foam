// dom-compiler: our Rust crate (dom-compiler/), built to wasm into ./wasm by
// `npm run wasm`. It reads the browser's layout of matching elements into GPU
// instance data. The rest of the site calls it only through this file.
import init, { compile } from './wasm/dom_compiler.js';

/** Floats per instance: [x, y, w, h, r, g, b, depth]. Must match STRIDE in dom-compiler/src/lib.rs. */
export const STRIDE = 8;

export const initDomCompiler = () => init();

/**
 * Instance data for every element under `root` matching `selector`, in
 * document px, coloured by the computed style property `colorProp`.
 */
export const compileRects = (root: Element, selector: string, colorProp: string): Float32Array<ArrayBuffer> =>
  new Float32Array(compile(root, selector, colorProp));
