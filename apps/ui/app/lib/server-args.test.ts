// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseHostArgument, parseHttpsArgument } from '#lib/server-args.js';

describe('parseHostArgument', () => {
  it('returns undefined when --host is absent', () => {
    expect(parseHostArgument(['node', 'server.ts', '--port', '4000', '--foo'])).toBeUndefined();
  });

  it("returns '0.0.0.0' for bare --host", () => {
    expect(parseHostArgument(['node', 'server.ts', '--host'])).toBe('0.0.0.0');
  });

  it("returns '0.0.0.0' for bare --host when followed by another flag", () => {
    expect(parseHostArgument(['node', 'server.ts', '--host', '--verbose'])).toBe('0.0.0.0');
  });

  it('returns explicit value for --host=<addr>', () => {
    expect(parseHostArgument(['node', 'server.ts', '--host=192.168.1.10'])).toBe('192.168.1.10');
  });

  it("returns '0.0.0.0' when --host= value is empty", () => {
    expect(parseHostArgument(['node', 'server.ts', '--host='])).toBe('0.0.0.0');
  });

  it('returns explicit value for --host <addr> (space-separated)', () => {
    expect(parseHostArgument(['node', 'server.ts', '--host', '10.0.0.22'])).toBe('10.0.0.22');
  });
});

describe('parseHttpsArgument', () => {
  it('returns false when --https is absent', () => {
    expect(parseHttpsArgument(['node', 'server.ts', '--host', '--port', '4000'])).toBe(false);
  });

  it('returns true for bare --https', () => {
    expect(parseHttpsArgument(['node', 'server.ts', '--https'])).toBe(true);
  });

  it('returns true for --https=true', () => {
    expect(parseHttpsArgument(['node', 'server.ts', '--https=true'])).toBe(true);
  });

  it('returns false for --https=false', () => {
    expect(parseHttpsArgument(['node', 'server.ts', '--https=false'])).toBe(false);
  });

  it('returns false for --no-https following --https', () => {
    expect(parseHttpsArgument(['node', 'server.ts', '--https', '--no-https'])).toBe(false);
  });

  it('ignores unrelated flags (--http and --httpsfoo)', () => {
    expect(parseHttpsArgument(['node', 'server.ts', '--http'])).toBe(false);
    expect(parseHttpsArgument(['node', 'server.ts', '--httpsfoo'])).toBe(false);
  });
});
