import { describe, expect, it } from 'vitest';
import { createNodeClient } from '@taucad/runtime/node';
import { defineRuntime } from '@taucad/runtime/worker';
import type { AnyRuntimeDefinition } from '@taucad/runtime/worker';
import type { RuntimeClient } from '@taucad/runtime/client';
import { createKernelParameterDeclaration, defineKernel } from '@taucad/runtime/kernel';
import type { KernelIssue } from '@taucad/runtime/types';
import { createGallerySessionWithClient } from '#runtime/session.js';

const skippedBoolean: KernelIssue = {
  code: 'RUNTIME',
  type: 'kernel',
  severity: 'error',
  message: 'difference: kernel error: Not Manifold — showing un-combined geometry (the boolean was skipped)',
};
const previewBytes = new TextEncoder().encode('Fixture artifact returned despite a kernel diagnostic');
const sessionInput = { kernel: 'openrscad', entryPath: 'main.fixture', files: { 'main.fixture': 'model' } } as const;

/** Real runtime boundaries with a kernel that deliberately returns partial artifacts and issues together. */
const createClient = async (descriptionIssue?: KernelIssue, warning?: KernelIssue): Promise<RuntimeClient> => {
  const kernel = defineKernel({
    id: 'gallery-diagnostic-fixture',
    name: 'GalleryDiagnosticFixture',
    version: '1.0.0',
    extensions: ['fixture'],
    views: { model: { title: 'Model', mimeType: 'model/gltf-binary' } },
    exports: { glb: { title: 'GLB', mimeType: 'model/gltf-binary', extension: 'glb' } },
    async initialize() {
      return {};
    },
    async resolve({ entryPath }) {
      return { resolved: [entryPath], unresolved: [] };
    },
    async describe() {
      return {
        success: true,
        data: {
          parameters: createKernelParameterDeclaration(
            { faultStage: 'none' },
            {
              type: 'object',
              properties: { faultStage: { type: 'string', enum: ['none', 'evaluate', 'render', 'export'] } },
              additionalProperties: false,
            },
            { id: 'urn:gallery:diagnostic-fixture', name: 'GalleryDiagnosticFixtureParameters' },
          ),
        },
        issues: descriptionIssue ? [descriptionIssue] : [],
      };
    },
    async evaluate({ parameters }) {
      return {
        handle: { faultStage: parameters['faultStage'] },
        views: ['model'] as const,
        exports: ['glb'] as const,
        issues: parameters['faultStage'] === 'evaluate' ? [skippedBoolean] : warning ? [warning] : [],
      };
    },
    async render({ handle }) {
      return {
        content: new Uint8Array(previewBytes),
        issues: handle.faultStage === 'render' ? [skippedBoolean] : warning ? [warning] : [],
      };
    },
    async export({ handle }) {
      return {
        files: [{ name: 'model.glb', bytes: new Uint8Array(previewBytes), mimeType: 'model/gltf-binary' }] as const,
        issues: handle.faultStage === 'export' ? [skippedBoolean] : warning ? [warning] : [],
      };
    },
  });
  // Match the gallery's dynamic public-client boundary; the real worker still validates the fixture's capabilities.
  return createNodeClient<AnyRuntimeDefinition>({ runtime: defineRuntime({ kernels: [kernel()] }) });
};

describe('gallery runtime diagnostic policy', () => {
  it('should expose immutable admitted parameters before a failed first render and allow a later correction', async () => {
    const client = await createClient();
    const session = await createGallerySessionWithClient(client, sessionInput);
    try {
      const description = session.parameterDescription;
      expect(description.defaultParameters).toEqual({ faultStage: 'none' });
      const field = description.jsonSchema?.properties?.['faultStage'];
      if (!field || typeof field !== 'object') {
        throw new Error('Expected the admitted fault-stage field.');
      }
      expect(field.enum).toEqual(['none', 'evaluate', 'render', 'export']);
      expect(Reflect.set(description.defaultParameters, 'faultStage', 'render')).toBe(false);
      expect(Reflect.set(field, 'type', 'number')).toBe(false);
      const declared = description.parameterManifest?.defaults;
      if (!declared) {
        throw new Error('Expected the admitted parameter manifest.');
      }
      expect(Reflect.set(declared, 'faultStage', 'render')).toBe(false);
      await expect(session.render({ faultStage: 'render' })).rejects.toThrow(skippedBoolean.message);
      expect(session.parameterDescription).toBe(description);
      await expect(session.export('glb')).rejects.toThrow(skippedBoolean.message);
      const recovered = await session.render({ faultStage: 'none' });
      expect(recovered.parameters).toEqual({ faultStage: 'none' });
      expect(recovered.defaultParameters).toEqual({ faultStage: 'none' });
      expect(recovered.jsonSchema).toEqual(description.jsonSchema);
      await expect(session.export('glb')).resolves.toMatchObject([{ name: 'model.glb', bytes: previewBytes }]);
    } finally {
      await session.dispose();
    }
  });

  it('should reject a successful description carrying an error diagnostic', async () => {
    const client = await createClient(skippedBoolean);
    await expect(createGallerySessionWithClient(client, sessionInput)).rejects.toThrow(skippedBoolean.message);
    await client.shutdown();
  });

  it.each(['evaluate', 'render'])(
    'should reject partial %s results, block their exports, and recover on reset',
    async (faultStage) => {
      const client = await createClient();
      const session = await createGallerySessionWithClient(client, sessionInput);
      try {
        const complete = await session.render();
        expect(complete.issues).toEqual([]);
        await expect(session.render({ faultStage })).rejects.toThrow(skippedBoolean.message);
        await expect(session.export('glb')).rejects.toThrow(skippedBoolean.message);
        await expect(session.render({})).resolves.toMatchObject({ parameters: { faultStage: 'none' }, issues: [] });
      } finally {
        await session.dispose();
      }
    },
  );

  it('should reject exported files when serialization also reports an error', async () => {
    const client = await createClient();
    const session = await createGallerySessionWithClient(client, sessionInput);
    try {
      await session.render({ faultStage: 'export' });
      await expect(session.export('glb')).rejects.toThrow(skippedBoolean.message);
    } finally {
      await session.dispose();
    }
  });

  it('should retain benign warnings and allow rendering and export', async () => {
    const warning: KernelIssue = { ...skippedBoolean, severity: 'warning', message: 'A harmless kernel warning' };
    const client = await createClient(warning, warning);
    const session = await createGallerySessionWithClient(client, sessionInput);
    try {
      const result = await session.render();
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every(({ severity }) => severity === 'warning')).toBe(true);
      await expect(session.export('glb')).resolves.toMatchObject([{ name: 'model.glb', bytes: previewBytes }]);
    } finally {
      await session.dispose();
    }
  });
});
