import sceneCode from './scene.wgsl?raw';
import compositeCode from './composite.wgsl?raw';
import { STRIDE } from '../lib/dom_compiler';
import { TEXT_STRIDE } from '../text/text_layout';

export const SAMPLES = 4; // MSAA for the scene passes; resolved into each scene texture

const alpha: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

/**
 * Bind group layouts and render pipelines for the scene passes (scene.wgsl)
 * and the route-to-route composite pass (composite.wgsl).
 */
export function createPipelines(device: GPUDevice, format: GPUTextureFormat) {
  const module = device.createShaderModule({ code: sceneCode });
  // Everything but solid text binds the photos too.
  const boxLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 5, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ],
  });
  const textLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });

  const pipeline = (
    topology: GPUPrimitiveTopology,
    vsEntry: string,
    fsEntry: string,
    stride: number,
    layout: GPUBindGroupLayout,
    blend?: GPUBlendState,
  ) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module,
        entryPoint: vsEntry,
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: stride * 4,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
              ...(stride === TEXT_STRIDE
                ? [
                    { shaderLocation: 3, offset: 32, format: 'float32x4' as const },
                    { shaderLocation: 4, offset: 48, format: 'float32' as const },
                  ]
                : []),
            ],
          },
          // Slot 2, one float per instance: per-glyph reveal progress for
          // text, photo layer (-1 = none) for boxes.
          {
            arrayStride: 4,
            stepMode: 'instance',
            attributes: [{ shaderLocation: stride === TEXT_STRIDE ? 5 : 6, offset: 0, format: 'float32' }],
          },
        ],
      },
      fragment: { module, entryPoint: fsEntry, targets: [{ format, blend }] },
      primitive: { topology },
      multisample: { count: SAMPLES },
      // Translucent draws test against depth but don't write it.
      depthStencil: { format: 'depth24plus', depthWriteEnabled: !blend, depthCompare: 'less-equal' },
    });

  const pipelines = {
    image: pipeline('triangle-list', 'vs_image', 'fs_image', STRIDE, boxLayout),
    boxSolid: pipeline('triangle-list', 'vs', 'fs_solid', STRIDE, boxLayout),
    boxWire: pipeline('line-list', 'vs', 'fs_wire', STRIDE, boxLayout),
    boxFade: pipeline('triangle-list', 'vs', 'fs_solid', STRIDE, boxLayout, alpha), // work list rows
    textSolid: pipeline('triangle-list', 'vs_text', 'fs_text', TEXT_STRIDE, textLayout, alpha),
    textWire: pipeline('line-list', 'vs_text', 'fs_wire', TEXT_STRIDE, boxLayout),
  };

  const compositeModule = device.createShaderModule({ code: compositeCode });
  const composite = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: compositeModule, entryPoint: 'vs' },
    fragment: { module: compositeModule, entryPoint: 'fs', targets: [{ format }] },
  });

  return { boxLayout, textLayout, pipelines, composite };
}
