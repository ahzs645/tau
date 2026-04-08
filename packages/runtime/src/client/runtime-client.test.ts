/* eslint-disable @typescript-eslint/naming-convention -- file names don't follow camelCase */
// @vitest-environment node
/**
 * Integration tests for the RuntimeClient render() and export() API.
 *
 * Uses createRuntimeClient + createInProcessTransport with the replicad kernel
 * to verify all RenderInput variations end-to-end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { HashedGeometryResult } from '#types/runtime.types.js';
import type { PerformanceEntryData, RuntimeCommand, RuntimeResponse } from '#types/runtime-protocol.types.js';
import type { RuntimeTransport } from '#transport/runtime-transport.js';
import { createRuntimeClient, fromMemoryFS } from '#index.js';
import { createInProcessTransport } from '#transport/in-process-transport.js';
import { replicad } from '#plugins/kernel-factories.js';
import { esbuild } from '#plugins/bundler-factories.js';

const boxCode = `
  import { makeBaseBox } from 'replicad';
  export default function main() {
    return makeBaseBox(10, 20, 30);
  }
`;

const sphereCode = `
  import { makeSphere } from 'replicad';
  export default function main() {
    return makeSphere(15);
  }
`;

const parametricCode = `
  import { makeBaseBox } from 'replicad';
  export const defaultParams = { width: 10, height: 20, depth: 30 };
  export default function main({ width, height, depth }: typeof defaultParams) {
    return makeBaseBox(width, height, depth);
  }
`;

const mainWithImport = `
  import { createBox } from './lib';
  export default function main() {
    return createBox();
  }
`;

const libraryCode = `
  import { makeBaseBox } from 'replicad';
  export function createBox() {
    return makeBaseBox(5, 10, 15);
  }
`;

const basePath = '/projects/test';
const fileName = 'box.ts';
const absolutePath = `${basePath}/${fileName}`;

beforeEach(() => {
  performance.clearMeasures();
  performance.clearMarks();
});

// =============================================================================
// Inline render -- single-file
// =============================================================================

describe('inline render (single-file)', () => {
  it('renders single-key code object with file inferred from key', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result = await client.render({ code: { 'box.ts': boxCode } });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
    }

    client.terminate();
  });

  it('renders single-key code with explicit file', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result = await client.render({
      code: { 'box.ts': boxCode },
      file: 'box.ts',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
    }

    client.terminate();
  });

  it('renders with parameters', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result = await client.render({
      code: { 'model.ts': parametricCode },
      parameters: { width: 50, height: 60, depth: 70 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
    }

    client.terminate();
  });
});

// =============================================================================
// Inline render -- multi-file
// =============================================================================

describe('inline render (multi-file)', () => {
  it('renders multi-key code with entry point file', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result = await client.render({
      code: {
        'main.ts': mainWithImport,
        'lib.ts': libraryCode,
      },
      file: 'main.ts',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
    }

    client.terminate();
  });

  it('renders multi-file with parameters', async () => {
    const parametricMain = `
      import { createBox } from './lib';
      export const defaultParams = { scale: 2 };
      export default function main({ scale }: typeof defaultParams) {
        void scale;
        return createBox();
      }
    `;

    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result = await client.render({
      code: {
        'main.ts': parametricMain,
        'lib.ts': libraryCode,
      },
      file: 'main.ts',
      parameters: { scale: 3 },
    });

    expect(result.success).toBe(true);

    client.terminate();
  });
});

// =============================================================================
// Filesystem render
// =============================================================================

describe('filesystem render', () => {
  it('renders with string file shorthand', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      fileSystem: fromMemoryFS({ [absolutePath]: boxCode }),
      transport: createInProcessTransport(),
    });

    const result = await client.render({ file: absolutePath });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
    }

    client.terminate();
  });

  it('renders with GeometryFile object', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      fileSystem: fromMemoryFS({ [absolutePath]: boxCode }),
      transport: createInProcessTransport(),
    });

    const result = await client.render({
      file: { filename: fileName, path: basePath },
      parameters: {},
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
    }

    client.terminate();
  });

  it('renders after notifyFileChanged for cache invalidation', async () => {
    const fileSystem = fromMemoryFS({ [absolutePath]: boxCode });

    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      fileSystem,
      transport: createInProcessTransport(),
    });

    const result1 = await client.render({ file: absolutePath });
    expect(result1.success).toBe(true);

    await fileSystem.writeFile(absolutePath, sphereCode);
    client.notifyFileChanged([absolutePath]);

    const result2 = await client.render({
      file: absolutePath,
    });
    expect(result2.success).toBe(true);

    client.terminate();
  });
});

// =============================================================================
// Geometry event (push mode)
// =============================================================================

describe('geometry event', () => {
  it('fires after render completes with same result as Promise', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    let eventResult: HashedGeometryResult | undefined;
    client.on('geometry', (result) => {
      eventResult = result;
    });

    const promiseResult = await client.render({ code: { 'box.ts': boxCode } });

    expect(eventResult).toBeDefined();
    expect(eventResult!.success).toBe(promiseResult.success);
    if (eventResult!.success && promiseResult.success) {
      expect(eventResult!.data.length).toBe(promiseResult.data.length);
    }

    client.terminate();
  });

  it('fires for error results', async () => {
    const invalidCode = `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        void makeBaseBox;
        throw new Error('intentional failure');
      }
    `;

    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    let eventResult: HashedGeometryResult | undefined;
    client.on('geometry', (result) => {
      eventResult = result;
    });

    const promiseResult = await client.render({
      code: { 'box.ts': invalidCode },
    });

    expect(promiseResult.success).toBe(false);
    expect(eventResult).toBeDefined();
    expect(eventResult!.success).toBe(false);

    client.terminate();
  });
});

// =============================================================================
// Export after render
// =============================================================================

describe('export after render', () => {
  it('exports to STEP after inline code render', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const renderResult = await client.render({ code: { 'box.ts': boxCode } });
    expect(renderResult.success).toBe(true);

    const exportResult = await client.export('step');
    expect(exportResult.success).toBe(true);
    if (exportResult.success) {
      expect(exportResult.data.name).toBeTruthy();
      expect(exportResult.data.bytes).toBeInstanceOf(Uint8Array);
      expect(exportResult.data.bytes.length).toBeGreaterThan(0);
      expect(exportResult.data.mimeType).toBeTruthy();
    }

    client.terminate();
  });

  it('exports to STEP after filesystem render', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      fileSystem: fromMemoryFS({ [absolutePath]: boxCode }),
      transport: createInProcessTransport(),
    });

    const renderResult = await client.render({ file: absolutePath });
    expect(renderResult.success).toBe(true);

    const exportResult = await client.export('step');
    expect(exportResult.success).toBe(true);
    if (exportResult.success) {
      expect(exportResult.data.name).toBeTruthy();
      expect(exportResult.data.bytes).toBeInstanceOf(Uint8Array);
      expect(exportResult.data.bytes.length).toBeGreaterThan(0);
      expect(exportResult.data.mimeType).toBeTruthy();
    }

    client.terminate();
  });
});

// =============================================================================
// Self-rendering export
// =============================================================================

describe('self-rendering export', () => {
  it('exports from single-file inline code', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result = await client.export('step', { code: { 'box.ts': boxCode } });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBeTruthy();
      expect(result.data.bytes).toBeInstanceOf(Uint8Array);
      expect(result.data.bytes.length).toBeGreaterThan(0);
      expect(result.data.mimeType).toBeTruthy();
    }

    client.terminate();
  });

  it('exports from multi-file inline code', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result = await client.export('step', {
      code: {
        'main.ts': mainWithImport,
        'lib.ts': libraryCode,
      },
      file: 'main.ts',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBeTruthy();
      expect(result.data.bytes).toBeInstanceOf(Uint8Array);
      expect(result.data.bytes.length).toBeGreaterThan(0);
    }

    client.terminate();
  });

  it('exports from filesystem file', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      fileSystem: fromMemoryFS({ [absolutePath]: boxCode }),
      transport: createInProcessTransport(),
    });

    const result = await client.export('step', { file: absolutePath });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBeTruthy();
      expect(result.data.bytes).toBeInstanceOf(Uint8Array);
      expect(result.data.bytes.length).toBeGreaterThan(0);
    }

    client.terminate();
  });
});

// =============================================================================
// Sequential re-renders
// =============================================================================

describe('sequential re-renders', () => {
  it('re-renders with modified code object', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result1 = await client.render({ code: { 'box.ts': boxCode } });
    expect(result1.success).toBe(true);

    const result2 = await client.render({ code: { 'box.ts': sphereCode } });
    expect(result2.success).toBe(true);

    client.terminate();
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe('error handling', () => {
  it('propagates errors for invalid code', async () => {
    const invalidCode = `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        void makeBaseBox;
        throw new Error('intentional failure');
      }
    `;

    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result = await client.render({ code: { 'box.ts': invalidCode } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.length).toBeGreaterThan(0);
    }

    client.terminate();
  });
});

// =============================================================================
// Telemetry
// =============================================================================

describe('telemetry', () => {
  it('delivers telemetry spans via inline render', async () => {
    const telemetryBatches: PerformanceEntryData[][] = [];

    const client = createRuntimeClient({
      kernels: [replicad({ ocTracing: 'summary' })],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    client.on('telemetry', (entries: PerformanceEntryData[]) => {
      telemetryBatches.push(entries);
    });

    await client.render({ code: { 'box.ts': boxCode } });

    const allEntries = telemetryBatches.flat();
    expect(allEntries.length).toBeGreaterThan(0);

    client.terminate();
  });
});

// =============================================================================
// Shared memory pools
// =============================================================================

describe('shared memory pools', () => {
  function createAutoInitTransport(): {
    transport: RuntimeTransport;
    capturedCommands: RuntimeCommand[];
  } {
    const capturedCommands: RuntimeCommand[] = [];
    let handler: ((message: RuntimeResponse) => void) | undefined;

    const transport: RuntimeTransport = {
      send(message: RuntimeCommand) {
        capturedCommands.push(message);
        if (message.type === 'initialize' && handler) {
          handler({ type: 'initialized', requestId: message.requestId });
        }
      },
      onMessage(h) {
        handler = h;
      },
      // oxlint-disable-next-line no-empty-function -- mock transport
      close() {},
    };

    return { transport, capturedCommands };
  }

  it('should allocate geometryPoolBuffer for configured geometry pool', async () => {
    const { transport, capturedCommands } = createAutoInitTransport();

    const client = createRuntimeClient({
      kernels: [],
      transport,
      sharedMemory: {
        geometry: { bytes: 1024, maxEntries: 10, eviction: 'lru' },
      },
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    const initCmd = capturedCommands.find((c) => c.type === 'initialize');
    expect(initCmd).toBeDefined();
    expect(initCmd!.geometryPoolBuffer).toBeInstanceOf(SharedArrayBuffer);
    expect(initCmd!.geometryPoolBuffer!.byteLength).toBe(1024);

    client.terminate();
  });

  it('should pass external filePoolBuffer through to initialize command', async () => {
    const { transport, capturedCommands } = createAutoInitTransport();
    const externalSAB = new SharedArrayBuffer(4096);

    const client = createRuntimeClient({
      kernels: [],
      transport,
      sharedMemory: {
        geometry: { bytes: 2048, maxEntries: 5, eviction: 'lru' },
      },
    });

    await client.connect({ fileSystem: fromMemoryFS(), filePoolBuffer: externalSAB });

    const initCmd = capturedCommands.find((c) => c.type === 'initialize');
    expect(initCmd!.geometryPoolBuffer).toBeInstanceOf(SharedArrayBuffer);
    expect(initCmd!.geometryPoolBuffer!.byteLength).toBe(2048);
    expect(initCmd!.filePoolBuffer).toBe(externalSAB);

    client.terminate();
  });

  it('should pass external filePoolBuffer via port-based connect', async () => {
    const { transport, capturedCommands } = createAutoInitTransport();
    const externalSAB = new SharedArrayBuffer(4096);
    const { port1 } = new MessageChannel();

    const client = createRuntimeClient({
      kernels: [],
      transport,
      sharedMemory: {
        geometry: { bytes: 1024, maxEntries: 10, eviction: 'lru' },
      },
    });

    await client.connect({ port: port1, filePoolBuffer: externalSAB });

    const initCmd = capturedCommands.find((c) => c.type === 'initialize');
    expect(initCmd!.filePoolBuffer).toBe(externalSAB);

    client.terminate();
  });

  it('should expose geometryPool on client after connect', async () => {
    const { transport } = createAutoInitTransport();

    const client = createRuntimeClient({
      kernels: [],
      transport,
      sharedMemory: {
        geometry: { bytes: 1024, maxEntries: 10, eviction: 'lru' },
      },
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    expect(client.geometryPool).toBeDefined();
    expect(typeof client.geometryPool!.store).toBe('function');
    expect(typeof client.geometryPool!.resolve).toBe('function');

    client.terminate();
  });

  it('should not include filePoolBuffer in initialize when not provided to connect', async () => {
    const { transport, capturedCommands } = createAutoInitTransport();

    const client = createRuntimeClient({
      kernels: [],
      transport,
      sharedMemory: {
        geometry: { bytes: 1024, maxEntries: 10, eviction: 'lru' },
      },
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    const initCmd = capturedCommands.find((c) => c.type === 'initialize');
    expect(initCmd!.filePoolBuffer).toBeUndefined();

    client.terminate();
  });

  it('should not create pools when sharedMemory is not configured', async () => {
    const { transport, capturedCommands } = createAutoInitTransport();

    const client = createRuntimeClient({
      kernels: [],
      transport,
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    const initCmd = capturedCommands.find((c) => c.type === 'initialize');
    expect(initCmd!.geometryPoolBuffer).toBeUndefined();
    expect(initCmd!.filePoolBuffer).toBeUndefined();
    expect(client.geometryPool).toBeUndefined();

    client.terminate();
  });

  it('should gracefully skip pool creation when SharedArrayBuffer is unavailable', async () => {
    const originalSAB = globalThis.SharedArrayBuffer;
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- test simulates missing SAB
    (globalThis as Record<string, unknown>)['SharedArrayBuffer'] = class {
      constructor() {
        throw new TypeError('SharedArrayBuffer is not available');
      }
    };

    try {
      const { transport, capturedCommands } = createAutoInitTransport();

      const client = createRuntimeClient({
        kernels: [],
        transport,
        sharedMemory: {
          geometry: { bytes: 1024, maxEntries: 10, eviction: 'lru' },
        },
      });

      await client.connect({ fileSystem: fromMemoryFS() });

      const initCmd = capturedCommands.find((c) => c.type === 'initialize');
      expect(initCmd!.geometryPoolBuffer).toBeUndefined();
      expect(client.geometryPool).toBeUndefined();

      client.terminate();
    } finally {
      globalThis.SharedArrayBuffer = originalSAB;
    }
  });
});

// =============================================================================
// Geometry transport resolution (two-layer type boundary)
// =============================================================================

describe('geometry transport resolution', () => {
  function createResolvingTransport(): {
    transport: RuntimeTransport;
    pushResponse: (response: RuntimeResponse) => void;
  } {
    let handler: ((message: RuntimeResponse) => void) | undefined;

    const transport: RuntimeTransport = {
      send(message: RuntimeCommand) {
        if (message.type === 'initialize' && handler) {
          handler({ type: 'initialized', requestId: message.requestId });
        }
      },
      onMessage(h) {
        handler = h;
      },
      // oxlint-disable-next-line no-empty-function -- mock transport
      close() {},
    };

    return {
      transport,
      pushResponse(response: RuntimeResponse) {
        handler?.(response);
      },
    };
  }

  it('should resolve pooled delivery from SharedPool before emitting to geometry subscribers', async () => {
    const { transport, pushResponse } = createResolvingTransport();

    const client = createRuntimeClient({
      kernels: [],
      transport,
      sharedMemory: {
        geometry: { bytes: 256 * 1024, maxEntries: 64, eviction: 'lru' },
      },
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    const pool = client.geometryPool!;
    const content = new Uint8Array([10, 20, 30]);
    pool.store('hash-0', content);

    let eventResult: HashedGeometryResult | undefined;
    client.on('geometry', (result) => {
      eventResult = result;
    });

    pushResponse({
      type: 'geometryComputed',
      requestId: '',
      result: {
        success: true,
        data: [
          {
            format: 'gltf',
            contentRef: { delivery: 'pooled', key: 'hash-0' },
            hash: 'hash-0',
          },
        ],
        issues: [],
      },
    });

    expect(eventResult).toBeDefined();
    expect(eventResult!.success).toBe(true);
    if (eventResult!.success) {
      expect(eventResult!.data[0]!.format).toBe('gltf');
      if (eventResult!.data[0]!.format === 'gltf') {
        const resolved = eventResult!.data[0]!.content;
        expect(resolved).toBeInstanceOf(Uint8Array);
        expect(resolved.byteLength).toBe(3);
        expect(resolved.buffer).toBeInstanceOf(ArrayBuffer);
        expect(resolved.buffer).not.toBeInstanceOf(SharedArrayBuffer);
        expect(resolved.byteOffset).toBe(0);
      }
    }

    client.terminate();
  });

  it('should pass inline delivery bytes through as content', async () => {
    const { transport, pushResponse } = createResolvingTransport();

    const client = createRuntimeClient({
      kernels: [],
      transport,
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    let eventResult: HashedGeometryResult | undefined;
    client.on('geometry', (result) => {
      eventResult = result;
    });

    const inlineBytes = new Uint8Array([1, 2, 3]);
    pushResponse({
      type: 'geometryComputed',
      requestId: '',
      result: {
        success: true,
        data: [
          {
            format: 'gltf',
            contentRef: { delivery: 'inline', bytes: inlineBytes },
            hash: 'h1',
          },
        ],
        issues: [],
      },
    });

    expect(eventResult).toBeDefined();
    expect(eventResult!.success).toBe(true);
    if (eventResult!.success && eventResult!.data[0]!.format === 'gltf') {
      expect(eventResult!.data[0]!.content).toEqual(inlineBytes);
    }

    client.terminate();
  });

  it('should resolve geometry via inline delivery when SAB pools failed to initialize', async () => {
    const originalSAB = globalThis.SharedArrayBuffer;
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- test simulates missing SAB
    (globalThis as Record<string, unknown>)['SharedArrayBuffer'] = class {
      constructor() {
        throw new TypeError('SharedArrayBuffer is not available');
      }
    };

    try {
      const { transport, pushResponse } = createResolvingTransport();

      const client = createRuntimeClient({
        kernels: [],
        transport,
        sharedMemory: {
          geometry: { bytes: 1024, maxEntries: 10, eviction: 'lru' },
        },
      });

      await client.connect({ fileSystem: fromMemoryFS() });

      let eventResult: HashedGeometryResult | undefined;
      client.on('geometry', (result) => {
        eventResult = result;
      });

      const inlineBytes = new Uint8Array([7, 8, 9]);
      pushResponse({
        type: 'geometryComputed',
        requestId: '',
        result: {
          success: true,
          data: [
            {
              format: 'gltf',
              contentRef: { delivery: 'inline', bytes: inlineBytes },
              hash: 'fallback-h1',
            },
          ],
          issues: [],
        },
      });

      expect(eventResult).toBeDefined();
      expect(eventResult!.success).toBe(true);
      if (eventResult!.success && eventResult!.data[0]!.format === 'gltf') {
        expect(eventResult!.data[0]!.content).toEqual(inlineBytes);
      }

      client.terminate();
    } finally {
      globalThis.SharedArrayBuffer = originalSAB;
    }
  });

  it('should pass SVG geometries through unchanged', async () => {
    const { transport, pushResponse } = createResolvingTransport();

    const client = createRuntimeClient({
      kernels: [],
      transport,
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    let eventResult: HashedGeometryResult | undefined;
    client.on('geometry', (result) => {
      eventResult = result;
    });

    pushResponse({
      type: 'geometryComputed',
      requestId: '',
      result: {
        success: true,
        data: [
          {
            format: 'svg',
            paths: ['M0 0'],
            viewbox: '0 0 100 100',
            name: 'test',
            hash: 'svg-h',
          },
        ],
        issues: [],
      },
    });

    expect(eventResult).toBeDefined();
    expect(eventResult!.success).toBe(true);
    if (eventResult!.success) {
      expect(eventResult!.data[0]!.format).toBe('svg');
    }

    client.terminate();
  });

  it('should pass error results through unchanged', async () => {
    const { transport, pushResponse } = createResolvingTransport();

    const client = createRuntimeClient({
      kernels: [],
      transport,
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    let eventResult: HashedGeometryResult | undefined;
    client.on('geometry', (result) => {
      eventResult = result;
    });

    pushResponse({
      type: 'geometryComputed',
      requestId: '',
      result: {
        success: false,
        issues: [{ message: 'fail', type: 'kernel', severity: 'error' }],
      },
    });

    expect(eventResult).toBeDefined();
    expect(eventResult!.success).toBe(false);

    client.terminate();
  });

  it('should resolve pooled content as standalone ArrayBuffer-backed Uint8Array', async () => {
    const { transport, pushResponse } = createResolvingTransport();

    const client = createRuntimeClient({
      kernels: [],
      transport,
      sharedMemory: {
        geometry: { bytes: 256 * 1024, maxEntries: 64, eviction: 'lru' },
      },
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    const pool = client.geometryPool!;
    const glbMagic = new Uint8Array([0x67, 0x6c, 0x54, 0x46]); // 'glTF'
    pool.store('sab-test-0', glbMagic);

    let eventResult: HashedGeometryResult | undefined;
    client.on('geometry', (result) => {
      eventResult = result;
    });

    pushResponse({
      type: 'geometryComputed',
      requestId: '',
      result: {
        success: true,
        data: [
          {
            format: 'gltf',
            contentRef: { delivery: 'pooled', key: 'sab-test-0' },
            hash: 'sab-test-0',
          },
        ],
        issues: [],
      },
    });

    expect(eventResult).toBeDefined();
    expect(eventResult!.success).toBe(true);
    if (eventResult!.success && eventResult!.data[0]!.format === 'gltf') {
      const content = eventResult!.data[0]!.content;

      // RuntimeClient encapsulates SAB resolution — consumers get ArrayBuffer-backed content
      expect(content.buffer).toBeInstanceOf(ArrayBuffer);
      expect(content.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      expect(content.byteOffset).toBe(0);
      expect(content.byteLength).toBe(4);
      expect(content.buffer.byteLength).toBe(content.byteLength);
      expect([...content]).toEqual([0x67, 0x6c, 0x54, 0x46]);

      // Consumers can safely pass content.buffer to GLTFLoader without offset concerns
      const decoded = new TextDecoder().decode(content);
      expect(decoded).toBe('glTF');
    }

    client.terminate();
  });

  it('should resolve render() Promise with resolved content', async () => {
    let handler: ((message: RuntimeResponse) => void) | undefined;
    let capturedRequestId: string | undefined;

    const transport: RuntimeTransport = {
      send(message: RuntimeCommand) {
        if (message.type === 'initialize' && handler) {
          handler({ type: 'initialized', requestId: message.requestId });
        }
        if (message.type === 'render') {
          capturedRequestId = message.requestId;
        }
      },
      onMessage(h) {
        handler = h;
      },
      // oxlint-disable-next-line no-empty-function -- mock transport
      close() {},
    };

    const client = createRuntimeClient({
      kernels: [],
      transport,
      sharedMemory: {
        geometry: { bytes: 256 * 1024, maxEntries: 64, eviction: 'lru' },
      },
    });

    await client.connect({ fileSystem: fromMemoryFS() });

    const pool = client.geometryPool!;
    const content = new Uint8Array([42, 43, 44]);
    pool.store('render-0', content);

    const renderPromise = client.render({ file: '/test.ts' });

    // Push response on next microtask so render() has time to set up pendingRender
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    handler!({
      type: 'geometryComputed',
      requestId: capturedRequestId!,
      result: {
        success: true,
        data: [
          {
            format: 'gltf',
            contentRef: { delivery: 'pooled', key: 'render-0' },
            hash: 'render-0',
          },
        ],
        issues: [],
      },
    });

    const result = await renderPromise;
    expect(result.success).toBe(true);
    if (result.success && result.data[0]!.format === 'gltf') {
      expect(result.data[0]!.content.byteLength).toBe(3);
    }

    client.terminate();
  });
});
