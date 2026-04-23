import { describe, it, expect } from 'vitest';
import { toolName, toolNames } from '#constants/tool.constants.js';
import { toolInputSchemas, getToolInputSchema } from '#schemas/tool-input.registry.js';

const requireSchema = (key: `tool-${string}`) => {
  const schema = getToolInputSchema(key);
  if (!schema) {
    throw new Error(`registry missing schema for ${key}`);
  }
  return schema;
};

describe('toolInputSchemas registry', () => {
  it('should expose a Zod schema for every static tool name', () => {
    for (const name of toolNames) {
      expect(getToolInputSchema(`tool-${name}`), `missing schema for tool-${name}`).toBeDefined();
    }
  });

  it('should validate a well-formed read_file input as the strict per-tool schema', () => {
    const result = requireSchema(`tool-${toolName.readFile}`).safeParse({
      targetFile: 'main.ts',
      limit: 15,
    });

    expect(result.success).toBe(true);
  });

  it('should reject a partial read_file input that lacks required targetFile', () => {
    const result = requireSchema(`tool-${toolName.readFile}`).safeParse({ limit: 15 });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues.some((issue) => issue.path.includes('targetFile'))).toBe(true);
  });

  it('should reject any non-empty input for empty-input tools (test_model)', () => {
    const result = requireSchema(`tool-${toolName.testModel}`).safeParse({ stray: 'value' });

    expect(result.success).toBe(false);
  });

  it('should accept the literal empty object for empty-input tools', () => {
    const result = requireSchema(`tool-${toolName.transferToCadExpert}`).safeParse({});

    expect(result.success).toBe(true);
  });
});

describe('getToolInputSchema', () => {
  it('should return the schema for a known static tool part type', () => {
    expect(getToolInputSchema(`tool-${toolName.readFile}`)).toBe(toolInputSchemas[`tool-${toolName.readFile}`]);
  });

  it('should return undefined for the dynamic-tool part type', () => {
    expect(getToolInputSchema('dynamic-tool')).toBeUndefined();
  });

  it('should return undefined for an unknown tool part type', () => {
    expect(getToolInputSchema('tool-not_a_real_tool')).toBeUndefined();
  });
});
