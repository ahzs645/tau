import { describe, expect, it, vi, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/naming-convention -- mocks mirror three.js RenderPipeline / WebGPU API spellings */
import { render } from '@testing-library/react';

const hoistedMocks = vi.hoisted(() => {
  const depthTextureNodeStub = Symbol('depthTextureNode');
  const aoRChannelStub = Symbol('aoRChannel');

  const prePassOutputTextureStub = {
    type: 0,
  };

  const glRenderSpy = vi.fn();
  const sceneStub: Record<string, unknown> = {};
  const cameraStub: Record<string, unknown> = {};

  const gpuGl = {
    isWebGPURenderer: true,
    render: glRenderSpy,
  };

  const prePassTextureNodeStub = {
    sample: vi.fn(() => Symbol('prePassColourSample')),
  };

  let priorityOneFrameCallback: ((_state: Record<string, unknown>, delta: number) => void) | undefined;

  const resetPriorityOneCallback = (): void => {
    priorityOneFrameCallback = undefined;
  };

  const getPriorityOneCallback = (): typeof priorityOneFrameCallback => priorityOneFrameCallback;

  function createDefaultThreeState(): {
    readonly gl: Record<string, unknown>;
    readonly scene: Record<string, unknown>;
    readonly camera: Record<string, unknown>;
  } {
    return {
      gl: gpuGl,
      scene: sceneStub,
      camera: cameraStub,
    };
  }

  /** `vi.fn` so suites can swap `gl` implementation (WebGPU vs WebGL stubs) safely. */
  const useThreeMock = vi.fn(createDefaultThreeState);

  const useFrameMock = (
    callback: (_state: Record<string, unknown>, delta: number) => void,
    priority?: number,
  ): void => {
    if (priority === 1) {
      priorityOneFrameCallback = callback;
    }
  };

  const postDisposeSpy = vi.fn();
  const aoDisposeSpy = vi.fn();

  const aoSampleImplementation = vi.fn(() => ({
    r: aoRChannelStub,
  }));

  const aoImplementation = vi.fn(() => ({
    radius: { value: 0 },
    thickness: { value: 0 },
    samples: { value: 0 },
    distanceFallOff: { value: 0 },
    resolutionScale: 0,
    useTemporalFiltering: false,
    getTextureNode: vi.fn(() => ({
      sample: aoSampleImplementation,
    })),
    dispose: aoDisposeSpy,
  }));

  const pipelineInstances: Array<{ outputNode?: unknown }> = [];

  const unsignedByteTypeStub = 1009;

  /** Pre-pass: opaque normals (depth comes from `getTextureNode('depth')`). */
  const prePassStub = {
    transparent: true,
    name: '',
    setMRT: vi.fn(),
    getTexture: vi.fn(() => prePassOutputTextureStub),
    getTextureNode: vi.fn((channel?: string): unknown => {
      if (channel === 'depth') {
        return depthTextureNodeStub;
      }

      return prePassTextureNodeStub;
    }),
  };

  const scenePassStub = {
    contextNode: undefined as unknown,
  };

  const passImplementation = vi.fn((): Record<string, unknown> => {
    return passImplementation.mock.calls.length === 1 ? prePassStub : scenePassStub;
  });

  const mrtImplementation = vi.fn();

  return {
    aoDisposeSpy,
    aoImplementation,
    aoRChannelStub,
    aoSampleImplementation,
    cameraStub,
    depthTextureNodeStub,
    getPriorityOneCallback,
    glRenderSpy,
    gpuGl,
    createDefaultThreeState,
    gpuGlFallback: {
      isWebGPURenderer: false,
      render: vi.fn(),
    },
    mrtImplementation,
    passImplementation,
    pipelineInstances,
    postDisposeSpy,
    prePassOutputTextureStub,
    prePassStub,
    prePassTextureNodeStub,
    resetPriorityOneCallback,
    scenePassStub,
    sceneStub,
    unsignedByteTypeStub,
    useFrameMock,
    useThreeMock,
  };
});

const builtinAOContextSpy = vi.fn((argument: unknown) => ({ kind: 'aoContext', argument }));
const colorToDirectionSpy = vi.fn((node: unknown) => ({ kind: 'colorToDirection', node }));
const directionToColorSpy = vi.fn((node: unknown) => ({ kind: 'directionToColor', node }));
const sampleSpy = vi.fn((mapper: (uv: unknown) => unknown) => ({ kind: 'sample', mapper }));
const screenUVStub = Symbol('screenUV');

const normalViewStub = Symbol('normalView');

vi.mock('three/tsl', () => ({
  builtinAOContext: builtinAOContextSpy,
  colorToDirection: colorToDirectionSpy,
  directionToColor: directionToColorSpy,
  mrt: hoistedMocks.mrtImplementation,
  normalView: normalViewStub,
  output: Symbol('output'),
  pass: hoistedMocks.passImplementation,
  sample: sampleSpy,
  screenUV: screenUVStub,
}));

vi.mock('three/addons/tsl/display/GTAONode.js', () => ({
  ao: hoistedMocks.aoImplementation,
}));

vi.mock('three/webgpu', () => {
  class RenderPipelineStub {
    public outputNode: unknown | undefined;

    // oxlint-disable-next-line @typescript-eslint/parameter-properties -- `erasableSyntaxOnly` forbids constructor parameter properties in Vitest specs
    public readonly renderer: { render: (...parameters: unknown[]) => void };

    public constructor(renderer: { render: (...parameters: unknown[]) => void }) {
      this.renderer = renderer;
      hoistedMocks.pipelineInstances.push(this);
    }

    public render(): void {
      this.renderer.render(hoistedMocks.sceneStub, hoistedMocks.cameraStub);
    }

    public dispose(): void {
      hoistedMocks.postDisposeSpy();
    }
  }

  return {
    RenderPipeline: RenderPipelineStub,
    UnsignedByteType: hoistedMocks.unsignedByteTypeStub,
    WebGPURenderer: vi.fn(),
  };
});

vi.mock('@react-three/fiber', async (importOriginal) => {
  const fiberFacadeUnknown: unknown = await importOriginal();
  const fiberFacade =
    fiberFacadeUnknown !== null && typeof fiberFacadeUnknown === 'object'
      ? (fiberFacadeUnknown as Record<string, unknown>)
      : {};

  return {
    ...fiberFacade,
    useFrame: vi.fn(hoistedMocks.useFrameMock),
    useThree: (
      ...argument: Parameters<typeof hoistedMocks.useThreeMock>
    ): ReturnType<(typeof hoistedMocks)['useThreeMock']> => hoistedMocks.useThreeMock(...argument),
  };
});

describe('PostProcessingWebGPU', () => {
  beforeEach(() => {
    hoistedMocks.resetPriorityOneCallback();
    hoistedMocks.glRenderSpy.mockClear();
    hoistedMocks.postDisposeSpy.mockClear();
    hoistedMocks.aoDisposeSpy.mockClear();

    hoistedMocks.pipelineInstances.length = 0;

    hoistedMocks.prePassStub.transparent = true;
    hoistedMocks.scenePassStub.contextNode = undefined;
    hoistedMocks.passImplementation.mockClear();
    hoistedMocks.prePassStub.setMRT.mockClear();
    hoistedMocks.prePassStub.getTexture.mockClear();
    hoistedMocks.prePassStub.getTextureNode.mockClear();
    hoistedMocks.prePassTextureNodeStub.sample.mockClear();

    builtinAOContextSpy.mockClear();
    colorToDirectionSpy.mockClear();
    directionToColorSpy.mockClear();
    hoistedMocks.mrtImplementation.mockClear();
    sampleSpy.mockClear();
    hoistedMocks.aoImplementation.mockClear();
    hoistedMocks.aoSampleImplementation.mockClear();

    hoistedMocks.prePassOutputTextureStub.type = 0;

    hoistedMocks.useThreeMock.mockImplementation(hoistedMocks.createDefaultThreeState);
  });

  it('pre-pass renders opaquely with MRT normals only (directionToColor, no velocity)', async () => {
    const { PostProcessingWebGPU } = await import('#components/geometry/graphics/three/post-processing-webgpu.js');

    render(<PostProcessingWebGPU />);

    expect(hoistedMocks.passImplementation).toHaveBeenCalled();
    expect(hoistedMocks.prePassStub.transparent).toBe(false);

    expect(hoistedMocks.mrtImplementation).toHaveBeenCalledWith({
      output: { kind: 'directionToColor', node: normalViewStub },
    });

    expect(directionToColorSpy).toHaveBeenCalledWith(normalViewStub);
  });

  it('sets pre-pass output texture to UnsignedByteType for packed normals', async () => {
    const { PostProcessingWebGPU } = await import('#components/geometry/graphics/three/post-processing-webgpu.js');

    render(<PostProcessingWebGPU />);

    expect(hoistedMocks.prePassStub.getTexture).toHaveBeenCalledWith('output');
    expect(hoistedMocks.prePassOutputTextureStub.type).toBe(hoistedMocks.unsignedByteTypeStub);
  });

  it('configures GTAO at half-resolution with temporal filtering from pre-pass depth + sampled normals', async () => {
    const { PostProcessingWebGPU } = await import('#components/geometry/graphics/three/post-processing-webgpu.js');

    render(<PostProcessingWebGPU />);

    const aoInstanceUnknown = hoistedMocks.aoImplementation.mock.results.at(0)?.value as
      | {
          readonly resolutionScale: number;
          readonly useTemporalFiltering: boolean;
        }
      | undefined;

    expect(aoInstanceUnknown).toBeTruthy();
    expect(aoInstanceUnknown!.resolutionScale).toBe(0.5);
    expect(aoInstanceUnknown!.useTemporalFiltering).toBe(true);

    expect(hoistedMocks.aoImplementation).toHaveBeenCalledWith(
      hoistedMocks.depthTextureNodeStub,
      sampleSpy.mock.results.at(0)?.value,
      hoistedMocks.cameraStub,
    );

    expect(sampleSpy).toHaveBeenCalled();
    const firstSampleCall = sampleSpy.mock.calls[0];
    expect(firstSampleCall).toBeDefined();
    const [mapperUnknown] = firstSampleCall!;
    expect(mapperUnknown).toEqual(expect.any(Function));
    const invokeMapper = mapperUnknown as (token: symbol) => void;
    invokeMapper(Symbol('uv'));

    expect(hoistedMocks.prePassTextureNodeStub.sample).toHaveBeenCalled();
    expect(colorToDirectionSpy).toHaveBeenCalled();
  });

  it('inject AO into the lit scene pass via builtinAOContext sampled at screen UV', async () => {
    const { PostProcessingWebGPU } = await import('#components/geometry/graphics/three/post-processing-webgpu.js');

    render(<PostProcessingWebGPU />);

    expect(hoistedMocks.aoSampleImplementation).toHaveBeenCalledWith(screenUVStub);
    expect(builtinAOContextSpy).toHaveBeenCalledWith(hoistedMocks.aoRChannelStub);
    expect(hoistedMocks.scenePassStub.contextNode).toEqual({
      kind: 'aoContext',
      argument: hoistedMocks.aoRChannelStub,
    });
  });

  it('sets RenderPipeline.outputNode to the lit scenePass (no temporal AA — MSAA handles AA)', async () => {
    const { PostProcessingWebGPU } = await import('#components/geometry/graphics/three/post-processing-webgpu.js');

    render(<PostProcessingWebGPU />);

    const pipeline = hoistedMocks.pipelineInstances.at(0);
    expect(pipeline).toBeTruthy();
    expect(pipeline!.outputNode).toBe(hoistedMocks.scenePassStub);
  });

  it('invokes RenderPipeline.render once per priority-1 frame without reassigning gl.render', async () => {
    const renderDescriptor = Object.getOwnPropertyDescriptor(hoistedMocks.gpuGl, 'render');
    const originalRenderFunction = hoistedMocks.gpuGl.render;

    const { PostProcessingWebGPU } = await import('#components/geometry/graphics/three/post-processing-webgpu.js');

    render(<PostProcessingWebGPU />);

    expect(Object.getOwnPropertyDescriptor(hoistedMocks.gpuGl, 'render')).toEqual(renderDescriptor);
    expect(hoistedMocks.gpuGl.render).toBe(originalRenderFunction);

    const frameCallback = hoistedMocks.getPriorityOneCallback();
    expect(frameCallback).toBeTypeOf('function');

    hoistedMocks.glRenderSpy.mockClear();
    frameCallback!({}, 0);
    expect(hoistedMocks.glRenderSpy).toHaveBeenCalledOnce();

    hoistedMocks.glRenderSpy.mockClear();
    frameCallback!({}, 0);
    expect(hoistedMocks.glRenderSpy).toHaveBeenCalledOnce();
  });

  it('disposes RenderPipeline + GTAONode on unmount', async () => {
    const { PostProcessingWebGPU } = await import('#components/geometry/graphics/three/post-processing-webgpu.js');

    const { unmount } = render(<PostProcessingWebGPU />);

    expect(hoistedMocks.postDisposeSpy).not.toHaveBeenCalled();
    expect(hoistedMocks.aoDisposeSpy).not.toHaveBeenCalled();

    unmount();

    expect(hoistedMocks.postDisposeSpy).toHaveBeenCalledTimes(1);
    expect(hoistedMocks.aoDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when renderer is not WebGPU (no pipeline construction)', async () => {
    hoistedMocks.useThreeMock.mockImplementation(() => ({
      gl: hoistedMocks.gpuGlFallback,
      scene: hoistedMocks.sceneStub,
      camera: hoistedMocks.cameraStub,
    }));

    const { PostProcessingWebGPU } = await import('#components/geometry/graphics/three/post-processing-webgpu.js');

    render(<PostProcessingWebGPU />);

    expect(hoistedMocks.passImplementation).not.toHaveBeenCalled();
    expect(hoistedMocks.aoImplementation).not.toHaveBeenCalled();
  });
});

/* eslint-enable @typescript-eslint/naming-convention -- end three.js / WebGPU mock spellings */
