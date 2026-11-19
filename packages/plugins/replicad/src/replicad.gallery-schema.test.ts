import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { esbuild } from '@taucad/esbuild';
import { createNodeClient } from '@taucad/runtime/node';
import { defineRuntime } from '@taucad/runtime/worker';
import type { Description } from '@taucad/runtime/client';
import { replicad } from '@taucad/replicad';

const runtime = defineRuntime({
  plugins: [replicad({ kernels: { default: { wasm: 'single' } } }), esbuild()],
});
const createClient = () => createNodeClient({ runtime });

const source = (schema: string): string => `
import { makeBaseBox } from 'replicad';
export const defaultParams = { width: 12, mode: 'solid' };
${schema}
export default function main(params = defaultParams) {
  return makeBaseBox(params.width, 10, 5);
}`;

const usableSchema = (description: Description) => {
  if (!description.success) {
    throw new Error(description.issues.map(({ message }) => message).join('; '));
  }
  const projection = description.parameters.legacyProjection;
  if (projection.status !== 'usable') {
    throw new Error('Expected an editable parameter schema.');
  }
  return projection.schema;
};

describe('Replicad exported gallery parameter schema', { timeout: 60_000 }, () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeAll(async () => {
    client = await createClient();
  });

  afterAll(async () => {
    await client?.shutdown();
  });

  it('should preserve authored constraints and labels through public parameter discovery', async () => {
    const description = await client.describe({
      source: {
        files: {
          'model.ts': source(`
export const jsonSchema = {
  type: 'object',
  properties: {
    width: { type: 'number', title: 'Outer width', description: 'Width in millimetres', minimum: 2, maximum: 40 },
    mode: { type: 'string', title: 'Shape mode', enum: ['solid', 'hollow'] },
  },
  required: ['width', 'mode'],
  additionalProperties: false,
};`),
        },
      },
    });
    const schema = usableSchema(description);
    expect(schema.properties?.['width']).toMatchObject({
      type: 'number',
      title: 'Outer width',
      description: 'Width in millimetres',
      minimum: 2,
      maximum: 40,
    });
    expect(schema.properties?.['mode']).toMatchObject({ title: 'Shape mode', enum: ['solid', 'hollow'] });
    if (description.success) {
      expect(description.parameters.defaults).toEqual({ width: 12, mode: 'solid' });
    }
  });

  it('should continue inferring parameters when a model exports no schema', async () => {
    const description = await client.describe({ source: { files: { 'model.ts': source('') } } });
    expect(usableSchema(description).properties?.['width']).toMatchObject({ type: 'number' });
  });

  it('should report an invalid declared schema instead of silently replacing it', async () => {
    const description = await client.describe({
      source: { files: { 'model.ts': source("export const jsonSchema = 'invalid';") } },
    });
    expect(description.success).toBe(false);
    expect(description.issues.map(({ message }) => message).join('; ')).toContain(
      'exported jsonSchema must be an object',
    );
  });
});
