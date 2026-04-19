// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import type { PerformanceEntryData } from '#types/runtime-protocol.types.js';
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

const basePath = '/projects/test';
const fileName = 'box.ts';
const absolutePath = `${basePath}/${fileName}`;

beforeEach(() => {
  performance.clearMeasures();
  performance.clearMarks();
});

describe('createInProcessTransport', () => {
  it('close() does not throw', () => {
    const transport = createInProcessTransport();
    expect(() => {
      transport.close();
    }).not.toThrow();
  });

  it('double close() is safe', () => {
    const transport = createInProcessTransport();
    transport.close();
    expect(() => {
      transport.close();
    }).not.toThrow();
  });
});

describe('createRuntimeClient with in-process transport', () => {
  it('renders geometry successfully', async () => {
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

  it('delivers telemetry spans', async () => {
    const telemetryBatches: PerformanceEntryData[][] = [];

    const client = createRuntimeClient({
      kernels: [replicad({ ocTracing: 'summary' })],
      bundlers: [esbuild()],
      fileSystem: fromMemoryFS({ [absolutePath]: boxCode }),
      transport: createInProcessTransport(),
    });

    client.on('telemetry', (entries: PerformanceEntryData[]) => {
      telemetryBatches.push(entries);
    });

    await client.render({
      file: { filename: fileName, path: basePath },
      parameters: {},
    });

    const allEntries = telemetryBatches.flat();
    expect(allEntries.length).toBeGreaterThan(0);

    const spanNames = allEntries.map((entry) => entry.name);
    expect(spanNames).toContain('kernel.bootstrap');
    expect(spanNames).toContain('kernel.init');

    client.terminate();
  });

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
      fileSystem: fromMemoryFS({ [absolutePath]: invalidCode }),
      transport: createInProcessTransport(),
    });

    const result = await client.render({
      file: { filename: fileName, path: basePath },
      parameters: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.length).toBeGreaterThan(0);
    }

    client.terminate();
  });

  it('supports multiple sequential renders', async () => {
    const fileSystem = fromMemoryFS({ [absolutePath]: boxCode });

    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      fileSystem,
      transport: createInProcessTransport(),
    });

    const result1 = await client.render({
      file: { filename: fileName, path: basePath },
      parameters: {},
    });
    expect(result1.success).toBe(true);

    const sphereCode = `
      import { makeSphere } from 'replicad';
      export default function main() {
        return makeSphere(15);
      }
    `;
    await fileSystem.writeFile(absolutePath, sphereCode);
    client.notifyFileChanged([absolutePath]);

    const result2 = await client.render({
      file: { filename: fileName, path: basePath },
      parameters: {},
    });
    expect(result2.success).toBe(true);

    client.terminate();
  });

  it('cleans up without leaving active handles', async () => {
    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      fileSystem: fromMemoryFS({ [absolutePath]: boxCode }),
      transport: createInProcessTransport(),
    });

    await client.render({
      file: { filename: fileName, path: basePath },
      parameters: {},
    });

    client.terminate();
  });
});
