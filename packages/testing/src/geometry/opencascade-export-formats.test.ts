/* eslint-disable @typescript-eslint/naming-convention -- test data uses filenames as object keys */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '@taucad/runtime';
import { inProcessTransport } from '@taucad/runtime/transport/in-process';
import { fromMemoryFs } from '@taucad/runtime/filesystem';
import { esbuild } from '@taucad/runtime/bundler';
import { opencascade } from '@taucad/runtime/kernels';
import { converterTranscoder } from '@taucad/runtime/transcoder';

/**
 * End-to-end export coverage for the opencascade kernel: the kernel-native
 * formats (glb, stl, step) plus the converter-transcoded ones the playground
 * advertises for OpenCASCADE project variants (3mf and obj via glb).
 *
 * One shared client for every format: a second OCCT wasm instance in the
 * same process rejects shapes from the first ("Expected null or instance of
 * TopoDS_Shape, got an instance of TopoDS_Shape").
 */
const boxCode = `import { BRepPrimAPI_MakeBox } from 'opencascade.js';
export default function main() { return new BRepPrimAPI_MakeBox(10, 10, 10).Shape(); }`;

let client: ReturnType<typeof createRuntimeClient>;

beforeAll(() => {
  client = createRuntimeClient({
    transport: inProcessTransport({ fileSystem: fromMemoryFs({ '/box.ts': boxCode }) }),
    kernels: [opencascade()],
    bundlers: [esbuild()],
    transcoders: [converterTranscoder()],
  });
});

afterAll(() => {
  client.terminate();
});

async function exportFormat(format: string): Promise<Uint8Array<ArrayBuffer>> {
  const result = await client.export(format as 'glb', { file: '/box.ts' });
  if (!result.success) {
    throw new Error(`${format} export failed: ${result.issues.map((issue) => issue.message).join('; ')}`);
  }

  return result.data.bytes;
}

const latin1Head = (bytes: Uint8Array<ArrayBuffer>, length: number): string =>
  Buffer.from(bytes.slice(0, length)).toString('latin1');

describe('opencascade kernel export formats', () => {
  it('exports glb natively', async () => {
    const bytes = await exportFormat('glb');
    expect(latin1Head(bytes, 4)).toBe('glTF');
  }, 120_000);

  it('exports stl natively', async () => {
    const bytes = await exportFormat('stl');
    expect(bytes.length).toBeGreaterThan(84);
  }, 120_000);

  it('exports step natively with BRep content', async () => {
    const bytes = await exportFormat('step');
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('ISO-10303-21');
    expect(text).toContain('ADVANCED_FACE');
  }, 120_000);

  it('exports 3mf through the converter transcoder (glb → 3mf)', async () => {
    const bytes = await exportFormat('3mf');
    // 3MF is an OPC zip container.
    expect(latin1Head(bytes, 2)).toBe('PK');
  }, 120_000);

  it('exports obj through the converter transcoder (glb → obj)', async () => {
    const bytes = await exportFormat('obj');
    expect(Buffer.from(bytes).toString('latin1')).toMatch(/(^|\n)v /u);
  }, 120_000);
});
