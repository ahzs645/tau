import { describe, it, expect } from 'vitest';
import { largeDepRegexFix } from '#large-dep-regex-fix.vite-plugin.js';

type ConfigResolvedHook = (config: { plugins: PluginStub[] }) => void;

type PluginStub = {
  name: string;
  transform?: unknown;
};

function callConfigResolved(plugins: PluginStub[]) {
  const plugin = largeDepRegexFix();
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Vite plugin hooks use object form; cast needed to call
  (plugin.configResolved as unknown as ConfigResolvedHook)({ plugins });
}

describe('largeDepRegexFix', () => {
  it('should have correct metadata', () => {
    const plugin = largeDepRegexFix();
    expect(plugin.name).toBe('vite:large-dep-regex-fix');
    expect(plugin.enforce).toBe('pre');
  });

  it('should replace regex code filter with string on target plugin', () => {
    const filter = { code: /new\s+URL.+import\.meta\.url/s };
    const targetPlugin: PluginStub = {
      name: 'vite:asset-import-meta-url',
      transform: {
        filter,
        handler() {
          /* No-op */
        },
      },
    };

    callConfigResolved([targetPlugin]);

    expect(filter.code).toBe('import.meta.url');
  });

  it('should not modify plugins with different names', () => {
    const originalRegex = /new\s+URL.+import\.meta\.url/s;
    const filter = { code: originalRegex };
    const otherPlugin: PluginStub = {
      name: 'some-other-plugin',
      transform: {
        filter,
        handler() {
          /* No-op */
        },
      },
    };

    callConfigResolved([otherPlugin]);

    expect(filter.code).toBe(originalRegex);
  });

  it('should leave target plugin unchanged when it has no transform hook', () => {
    const targetPlugin: PluginStub = {
      name: 'vite:asset-import-meta-url',
    };

    callConfigResolved([targetPlugin]);

    expect(targetPlugin.transform).toBeUndefined();
  });

  it('should leave transform unchanged when it is a plain function without filter', () => {
    const originalTransform = () => {
      /* No-op */
    };
    const targetPlugin: PluginStub = {
      name: 'vite:asset-import-meta-url',
      transform: originalTransform,
    };

    callConfigResolved([targetPlugin]);

    expect(targetPlugin.transform).toBe(originalTransform);
  });

  it('should not replace filter.code when it is already a string', () => {
    const filter = { code: 'already-a-string' };
    const targetPlugin: PluginStub = {
      name: 'vite:asset-import-meta-url',
      transform: {
        filter,
        handler() {
          /* No-op */
        },
      },
    };

    callConfigResolved([targetPlugin]);

    expect(filter.code).toBe('already-a-string');
  });

  it('should leave all plugins unmodified when array is empty', () => {
    const plugins: PluginStub[] = [];

    callConfigResolved(plugins);

    expect(plugins).toHaveLength(0);
  });

  it('should find target among many plugins', () => {
    const filter = { code: /test/s };
    const plugins: PluginStub[] = [
      { name: 'plugin-a' },
      {
        name: 'plugin-b',
        transform() {
          /* No-op */
        },
      },
      {
        name: 'vite:asset-import-meta-url',
        transform: {
          filter,
          handler() {
            /* No-op */
          },
        },
      },
      { name: 'plugin-c' },
    ];

    callConfigResolved(plugins);

    expect(filter.code).toBe('import.meta.url');
  });
});
