/* eslint-disable @typescript-eslint/naming-convention -- file names don't follow camelCase */
// @vitest-environment node
/**
 * Integration tests for the KernelClient render() and export() API.
 *
 * Uses createKernelClient + createInProcessTransport with the replicad kernel
 * to verify all RenderInput variations end-to-end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { HashedGeometryResult } from '#types/kernel.types.js';
import type { PerformanceEntryData } from '#types/kernel-protocol.types.js';
import { createKernelClient, fromMemoryFS } from '#index.js';
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

const basePath = '/builds/test';
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
    const client = createKernelClient({
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
    const client = createKernelClient({
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
    const client = createKernelClient({
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
    const client = createKernelClient({
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

    const client = createKernelClient({
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
    const client = createKernelClient({
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
    const client = createKernelClient({
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

    const client = createKernelClient({
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
    const client = createKernelClient({
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

    const client = createKernelClient({
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
    const client = createKernelClient({
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
    const client = createKernelClient({
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
    const client = createKernelClient({
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
    const client = createKernelClient({
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
    const client = createKernelClient({
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
    const client = createKernelClient({
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

    const client = createKernelClient({
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

    const client = createKernelClient({
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
