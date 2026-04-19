/* eslint-disable @typescript-eslint/naming-convention -- test data uses filenames as object keys */
// @vitest-environment node
/**
 * Kernel Integration Test
 *
 * Reproduces the exact production wiring between FileService, the filesystem
 * bridge, createRuntimeClient, and multi-kernel selection to deterministically
 * demonstrate the empty-geometry failure.
 *
 * Uses Node vitest environment for MessageChannel/MessagePort support and WASM
 * kernel loading. The kernel runs in-process via createInProcessTransport.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  ProviderRegistry,
  ResourceQueue,
  DirectoryTreeCache,
  ChangeEventBus,
  FileService,
  MountTable,
} from '@taucad/filesystem';
import { createBridgeServer, createBridgeProxy } from '@taucad/runtime/filesystem';
import { createRuntimeClient } from '@taucad/runtime';
import type { RuntimeClient } from '@taucad/runtime';
import { replicad, tau } from '@taucad/runtime/kernels';
import { esbuild } from '@taucad/runtime/bundler';
import { createInProcessTransport } from '@taucad/runtime/transport';
import type { HashedGeometryResult } from '@taucad/runtime/types';

type TestKernels = readonly [ReturnType<typeof replicad>, ReturnType<typeof tau>];
type TestRuntimeClient = RuntimeClient<TestKernels>;

const hollowBoxSource = `
import { drawRoundedRectangle } from 'replicad';
import type { Shape3D } from 'replicad';

export const defaultParams = {
  width: 100,
  length: 150,
  height: 50,
  thickness: 2,
  cornerRadius: 5,
};

export default function main(p = defaultParams): Shape3D {
  const outer = drawRoundedRectangle(p.width, p.length, p.cornerRadius)
    .sketchOnPlane()
    .extrude(p.height);
  const hollowBox = outer.shell(p.thickness, (f) => f.inPlane('XY', p.height));
  return hollowBox;
}
`;

async function createFileService(): Promise<FileService> {
  const providerRegistry = new ProviderRegistry();
  const provider = await providerRegistry.createMountProvider('memory');
  const mountTable = new MountTable();
  mountTable.mount('/', provider, { backend: 'memory' });

  const resourceQueue = new ResourceQueue();
  const treeCache = new DirectoryTreeCache();
  const eventBus = new ChangeEventBus();

  return new FileService({
    providerRegistry,
    resourceQueue,
    treeCache,
    eventBus,
    mountTable,
  });
}

describe('Kernel Integration — FileService bridge', { timeout: 120_000 }, () => {
  let client: TestRuntimeClient | undefined;

  afterEach(() => {
    client?.terminate();
    client = undefined;
  });

  // ---------------------------------------------------------------------------
  // Layer 1: FileService Bridge Isolation
  // ---------------------------------------------------------------------------

  it('dispatches readFile correctly through the bridge', async () => {
    const fileService = await createFileService();

    await fileService.writeFile('/test/hello.ts', 'export default 42;');

    const channel = new MessageChannel();
    createBridgeServer(fileService, channel.port1);
    const proxy = createBridgeProxy<{
      readFile(path: string, encoding: 'utf8'): Promise<string>;
    }>(channel.port2);

    const content = await proxy.readFile('/test/hello.ts', 'utf8');
    expect(content).toBe('export default 42;');

    proxy.dispose();
    channel.port1.close();
  });

  it('dispatches exists correctly through the bridge', async () => {
    const fileService = await createFileService();

    await fileService.writeFile('/test/a.ts', 'a');

    const channel = new MessageChannel();
    createBridgeServer(fileService, channel.port1);
    const proxy = createBridgeProxy<{
      exists(path: string): Promise<boolean>;
    }>(channel.port2);

    expect(await proxy.exists('/test/a.ts')).toBe(true);
    expect(await proxy.exists('/test/nonexistent.ts')).toBe(false);

    proxy.dispose();
    channel.port1.close();
  });

  // ---------------------------------------------------------------------------
  // Layer 2: RuntimeClient + FileService Bridge (render)
  // ---------------------------------------------------------------------------

  it('connects via FileService-backed port and renders non-empty geometry', async () => {
    const fileService = await createFileService();

    await fileService.writeFile('/projects/proj_hollow_box/main.ts', hollowBoxSource);

    client = createRuntimeClient({
      kernels: [replicad({ withBrepEdges: true }), tau()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const channel = new MessageChannel();
    createBridgeServer(fileService, channel.port1);
    await client.connect({ port: channel.port2 });

    const result = await client.render({
      file: { path: '/projects/proj_hollow_box', filename: 'main.ts' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Layer 3: Event-Driven setFile Path (exact production flow)
  // ---------------------------------------------------------------------------

  it('produces non-empty geometry via setFile event callback', async () => {
    const fileService = await createFileService();

    await fileService.writeFile('/projects/proj_hollow_box/main.ts', hollowBoxSource);

    client = createRuntimeClient({
      kernels: [replicad({ withBrepEdges: true }), tau()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const channel = new MessageChannel();
    createBridgeServer(fileService, channel.port1);
    await client.connect({ port: channel.port2 });

    const geometryPromise = new Promise<HashedGeometryResult>((resolve) => {
      client!.on('geometry', resolve);
    });

    client.setFile({ path: '/projects/proj_hollow_box', filename: 'main.ts' }, {});

    const result = await geometryPromise;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Layer 4: Control — fromFsLike Path (known-good inline code)
  // ---------------------------------------------------------------------------

  it('renders hollow box via inline code path (control)', async () => {
    client = createRuntimeClient({
      kernels: [replicad({ withBrepEdges: true }), tau()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const result = await client.render({
      code: { 'main.ts': hollowBoxSource },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
    }
  });
});
