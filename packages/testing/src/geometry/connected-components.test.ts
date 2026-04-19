// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRuntimeClient } from '@taucad/runtime';
import { createInProcessTransport } from '@taucad/runtime/transport';
import { replicad } from '@taucad/runtime/kernels';
import { esbuild } from '@taucad/runtime/bundler';
import { NodeIO } from '@gltf-transform/core';
import { countConnectedComponents } from '#geometry/connected-components.js';

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

const compoundCode = `
  import { makeBaseBox } from 'replicad';
  export default function main() {
    const box1 = makeBaseBox(10, 10, 10);
    const box2 = makeBaseBox(10, 10, 10).translate(50, 0, 0);
    return box1.fuse(box2);
  }
`;

const fusedCode = `
  import { makeBaseBox, makeSphere } from 'replicad';
  export default function main() {
    const box = makeBaseBox(20, 20, 20);
    const sphere = makeSphere(12);
    return box.fuse(sphere);
  }
`;

const multiShapeCode = `
  import { makeBaseBox, makeSphere } from 'replicad';
  export default function main() {
    const box = makeBaseBox(10, 20, 30);
    const sphere = makeSphere(5).translateZ(50);
    return [{ shape: box, name: 'box' }, { shape: sphere, name: 'sphere' }];
  }
`;

describe('countConnectedComponents', () => {
  let boxGlb: Uint8Array<ArrayBuffer>;
  let compoundGlb: Uint8Array<ArrayBuffer>;
  let fusedGlb: Uint8Array<ArrayBuffer>;
  let multiShapeGlb: Uint8Array<ArrayBuffer>;

  beforeAll(async () => {
    [boxGlb, compoundGlb, fusedGlb, multiShapeGlb] = await Promise.all([
      renderGlb('box.ts', boxCode),
      renderGlb('compound.ts', compoundCode),
      renderGlb('fused.ts', fusedCode),
      renderGlb('multi.ts', multiShapeCode),
    ]);
  }, 120_000);

  it('should report 1 component for a single solid', async () => {
    const io = new NodeIO();
    const document = await io.readBinary(boxGlb);
    expect(countConnectedComponents(document)).toBe(1);
  });

  it('should report 2 components for non-overlapping fused boxes', async () => {
    const io = new NodeIO();
    const document = await io.readBinary(compoundGlb);
    expect(countConnectedComponents(document)).toBe(2);
  });

  it('should report 1 component for overlapping fused shapes', async () => {
    const io = new NodeIO();
    const document = await io.readBinary(fusedGlb);
    expect(countConnectedComponents(document)).toBe(1);
  });

  it('should report separate components across multiple meshes', async () => {
    const io = new NodeIO();
    const document = await io.readBinary(multiShapeGlb);
    expect(countConnectedComponents(document)).toBe(2);
  });
});
