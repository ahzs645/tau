// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRuntimeClient } from '@taucad/runtime';
import { createInProcessTransport } from '@taucad/runtime/transport';
import { replicad } from '@taucad/runtime/kernels';
import { esbuild } from '@taucad/runtime/bundler';
import { analyzeGlb } from '#geometry/analyze-glb.js';

async function renderGlb(filename: string, code: string): Promise<Uint8Array<ArrayBuffer>> {
  const client = createRuntimeClient({
    kernels: [replicad()],
    bundlers: [esbuild()],
    transport: createInProcessTransport(),
  });

  try {
    const result = await client.render({ code: { [filename]: code }, file: filename });
    if (!result.success) {
      throw new Error(`Render failed: ${result.issues.map((i) => i.message).join('; ')}`);
    }
    const gltf = result.data.find((g) => g.format === 'gltf');
    if (!gltf) {
      throw new Error('No GLTF geometry in render result');
    }
    return gltf.content;
  } finally {
    client.terminate();
  }
}

const boxCode = `
  import { makeBaseBox } from 'replicad';
  export default function main() {
    return makeBaseBox(10, 20, 30);
  }
`;

describe('analyzeGlb', () => {
  let boxGlb: Uint8Array<ArrayBuffer>;

  beforeAll(async () => {
    boxGlb = await renderGlb('box.ts', boxCode);
  }, 120_000);

  it('should return valid stats for a simple box', async () => {
    const stats = await analyzeGlb(boxGlb);

    expect(stats.vertexCount).toBeGreaterThan(0);
    expect(stats.meshCount).toBe(1);
    expect(stats.connectedComponents).toBe(1);
    expect(stats.watertight).toBe(true);
    expect(stats.boundingBox).toBeDefined();
  });

  it('should handle misaligned buffer (Socket.IO simulation)', async () => {
    const padded = new ArrayBuffer(boxGlb.byteLength + 3);
    const misaligned = new Uint8Array(padded, 3);
    misaligned.set(boxGlb);

    const stats = await analyzeGlb(misaligned);

    expect(stats.vertexCount).toBeGreaterThan(0);
    expect(stats.meshCount).toBe(1);
  });

  it('should throw for invalid GLB data', async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    await expect(analyzeGlb(garbage)).rejects.toThrow();
  });

  it('should throw for empty buffer', async () => {
    await expect(analyzeGlb(new Uint8Array(0))).rejects.toThrow();
  });

  it('should report watertight=true for a closed solid', async () => {
    const stats = await analyzeGlb(boxGlb);
    expect(stats.watertight).toBe(true);
  });

  it('should compute bounding box dimensions', async () => {
    const stats = await analyzeGlb(boxGlb);

    expect(stats.boundingBox).toBeDefined();
    expect(stats.boundingBox!.size).toHaveLength(3);
    expect(stats.boundingBox!.center).toHaveLength(3);
    // MakeBaseBox(10, 20, 30) → glTF meters: 0.01 × 0.02 × 0.03
    for (const dim of stats.boundingBox!.size) {
      expect(dim).toBeGreaterThan(0);
    }
  });
});
