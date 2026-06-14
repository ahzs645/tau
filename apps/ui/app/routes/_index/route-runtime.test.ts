/* eslint-disable no-await-in-loop -- runtime smoke uses sequential WASM clients to avoid cross-kernel state bleed */
import { describe, expect, it } from 'vitest';
import type { FileExtension } from '@taucad/types';
import { createNodeClient } from '@taucad/runtime/node';
import { replicad } from '@taucad/runtime/kernels';
import { esbuild } from '@taucad/runtime/bundler';
import { geometryCache, gltfCoordinateTransform, gltfEdgeDetection, parameterCache } from '@taucad/runtime/middleware';
import { converterTranscoder } from '@taucad/runtime/transcoder';
import { assertSuccess, createGeometryFile, createTestWorker } from '@taucad/runtime/testing';
import opencascadeKernel from '@taucad/runtime/kernels/opencascade';
import replicadKernel from '@taucad/runtime/kernels/replicad';
import { openscad } from '@taucad/openscad';
import { playgroundExamples } from '#routes/_index/playground-examples.js';

const exportCases: ReadonlyArray<{
  readonly exampleId: string;
  readonly format: FileExtension;
}> = [
  { exampleId: 'openscad-bracket', format: 'glb' },
  { exampleId: 'gel-comb-scad', format: 'glb' },
  { exampleId: 'networking-rack-scad', format: 'glb' },
  { exampleId: 'replicad-tray', format: 'step' },
  { exampleId: 'replicad-tray', format: 'stl' },
];

describe('root playground runtime exports', () => {
  it('exports representative root examples through Tau runtime formats', { timeout: 120_000 }, async () => {
    for (const { exampleId, format } of exportCases) {
      const client = await createNodeClient(undefined, {
        kernels: [openscad(), replicad({ wasm: 'auto', withBrepEdges: true })],
        bundlers: [esbuild()],
        middleware: [parameterCache(), geometryCache(), gltfCoordinateTransform(), gltfEdgeDetection()],
        transcoders: [converterTranscoder()],
      });

      try {
        const example = playgroundExamples.find((candidate) => candidate.id === exampleId);
        expect(example, exampleId).toBeDefined();
        expect(example?.exportFormats).toContain(format);

        const result = await client.export(format, {
          code: {
            [example!.mainFile]: example!.code,
          },
          file: example!.mainFile,
        });

        expect(result.success, `${exampleId} should export ${format}`).toBe(true);
        if (result.success) {
          expect(result.data.bytes.byteLength).toBeGreaterThan(0);
        }
      } finally {
        client.terminate();
      }
    }
  });

  it('preserves exported enum schemas so selector parameters auto-render', { timeout: 30_000 }, async () => {
    const example = playgroundExamples.find((candidate) => candidate.id === 'replicad-tray');
    expect(example).toBeDefined();

    const worker = await createTestWorker(replicadKernel, {
      [example!.mainFile]: example!.code,
    });

    const parametersResult = await worker.getParameters(createGeometryFile(example!.mainFile));
    assertSuccess(parametersResult, 'parameters for Replicad root example');

    expect(parametersResult.data.defaultParameters).toMatchObject({ style: 'open' });
    expect(parametersResult.data.jsonSchema).toMatchObject({
      properties: {
        style: {
          enum: ['open', 'shallow', 'solid'],
        },
      },
    });
  });

  it('exports the direct OpenCascade root example through the OpenCascade kernel', { timeout: 30_000 }, async () => {
    const example = playgroundExamples.find((candidate) => candidate.id === 'opencascade-box');
    expect(example).toBeDefined();
    expect(example?.exportFormats).toContain('step');

    const worker = await createTestWorker(opencascadeKernel, {
      [example!.mainFile]: example!.code,
    });

    const createResult = await worker.createGeometry({
      file: createGeometryFile(example!.mainFile),
      parameters: {},
    });
    assertSuccess(createResult, 'createGeometry for direct OpenCascade root example');

    const exportResult = await worker.exportGeometry('step');
    assertSuccess(exportResult, 'STEP export for direct OpenCascade root example');
    expect(exportResult.data[0]?.bytes.byteLength).toBeGreaterThan(0);
    expect(exportResult.data[0]?.mimeType).toBe('application/step');
  });
});
