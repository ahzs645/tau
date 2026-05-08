import type { KernelProvider } from '@taucad/runtime';
import { describe, expect, it } from 'vitest';
import {
  formatAddTopLevelExportRecovery,
  getKernelConfig,
} from '#api/chat/prompts/kernel-prompt-configs/kernel.prompt.config.js';

const allKernels: readonly KernelProvider[] = ['openscad', 'replicad', 'jscad', 'manifold', 'opencascadejs', 'zoo'];

describe('KernelConfig.topLevelExportExample', () => {
  describe.each(allKernels)('%s', (kernel) => {
    const config = getKernelConfig(kernel);

    it('should expose a non-empty topLevelExportExample snippet', () => {
      expect(config.topLevelExportExample.trim().length).toBeGreaterThan(0);
    });

    it('should never instruct the agent to remove a file or skip the test', () => {
      const corpus = [config.topLevelExportExample, formatAddTopLevelExportRecovery(config)].join('\n');
      expect(corpus).not.toMatch(/remove .* from test\.json/i);
      expect(corpus).not.toMatch(/skip(?:ping)? the test/i);
    });
  });

  describe('kernel-specific vocabulary', () => {
    it('openscad example should mention a top-level invocation', () => {
      const config = getKernelConfig('openscad');
      expect(config.topLevelExportExample).toMatch(/\(\s*\)|invocation|module/i);
    });

    it('replicad example should mention Shape3D', () => {
      const config = getKernelConfig('replicad');
      expect(config.topLevelExportExample).toMatch(/Shape3D/);
    });

    it('jscad example should mention Geom3', () => {
      const config = getKernelConfig('jscad');
      expect(config.topLevelExportExample).toMatch(/Geom3/);
    });

    it('manifold example should mention Manifold', () => {
      const config = getKernelConfig('manifold');
      expect(config.topLevelExportExample).toMatch(/Manifold/);
    });

    it('opencascadejs example should mention TopoDS_Shape', () => {
      const config = getKernelConfig('opencascadejs');
      expect(config.topLevelExportExample).toMatch(/TopoDS_Shape/);
    });

    it('zoo (KCL) example should mention extrude', () => {
      const config = getKernelConfig('zoo');
      expect(config.topLevelExportExample).toMatch(/extrude/i);
    });
  });
});

describe('KernelConfig.multiFileExample', () => {
  describe.each(allKernels)('%s', (kernel) => {
    const config = getKernelConfig(kernel);
    const example = config.multiFileExample;

    it('should ship a non-empty multiFileExample slot', () => {
      expect(example).toBeDefined();
    });

    it('should declare a mainFile that exists in files[]', () => {
      if (!example) {
        throw new Error('multiFileExample is required');
      }
      const paths = example.files.map((f) => f.path);
      expect(paths).toContain(example.mainFile);
    });

    it('should ship at least one library file alongside the entry (minimal multi-file demo)', () => {
      if (!example) {
        throw new Error('multiFileExample is required');
      }
      expect(example.files.length).toBeGreaterThanOrEqual(2);
    });

    it('should populate every file with non-empty content', () => {
      if (!example) {
        throw new Error('multiFileExample is required');
      }
      for (const file of example.files) {
        expect(file.content.trim().length).toBeGreaterThan(0);
      }
    });

    it('should use the kernel fileExtension on every file', () => {
      if (!example) {
        throw new Error('multiFileExample is required');
      }
      for (const file of example.files) {
        expect(file.path.endsWith(config.fileExtension)).toBe(true);
      }
    });
  });

  describe('OpenSCAD `use` regression guard (dollhouse `include`-duplicate smoking gun)', () => {
    it('should import library files with `use <…>` and never `include <…>`', () => {
      const example = getKernelConfig('openscad').multiFileExample;
      if (!example) {
        throw new Error('multiFileExample is required');
      }
      const main = example.files.find((f) => f.path === 'main.scad')?.content ?? '';
      expect(main).toMatch(/use\s*</);
      expect(main).not.toMatch(/include\s*</);
    });
  });

  describe('TS-based kernels (full-nesting) follow ESM relative-import idiom', () => {
    const tsKernels = ['replicad', 'jscad', 'manifold', 'opencascadejs'] as const;

    describe.each(tsKernels)('%s', (kernel) => {
      const config = getKernelConfig(kernel);
      const example = config.multiFileExample;

      it("should import the library file with `from './lib/<name>.js'`", () => {
        if (!example) {
          throw new Error('multiFileExample is required');
        }
        const main = example.files.find((f) => f.path === example.mainFile)?.content ?? '';
        expect(main).toMatch(/from\s+["']\.\/lib\/[\w-]+\.js["']/);
      });

      it('should keep the library file under `lib/`', () => {
        if (!example) {
          throw new Error('multiFileExample is required');
        }
        const libFile = example.files.find((f) => f.path !== example.mainFile);
        expect(libFile?.path.startsWith('lib/')).toBe(true);
      });

      it('library file should expose at least one `export`', () => {
        if (!example) {
          throw new Error('multiFileExample is required');
        }
        const libFile = example.files.find((f) => f.path !== example.mainFile);
        expect(libFile?.content).toMatch(/\bexport\b/);
      });
    });
  });

  describe('KCL (assembly-only) keeps the layout flat', () => {
    const example = getKernelConfig('zoo').multiFileExample;

    it('should not place any file under a subdirectory', () => {
      if (!example) {
        throw new Error('multiFileExample is required');
      }
      for (const file of example.files) {
        expect(file.path.includes('/')).toBe(false);
      }
    });

    it('should use the KCL `import … from "…"` idiom in the entry file', () => {
      if (!example) {
        throw new Error('multiFileExample is required');
      }
      const main = example.files.find((f) => f.path === example.mainFile)?.content ?? '';
      expect(main).toMatch(/import\s+\w+\s+from\s+"[^"]+\.kcl"/);
    });
  });
});

describe('formatAddTopLevelExportRecovery', () => {
  describe.each(allKernels)('%s', (kernel) => {
    const config = getKernelConfig(kernel);
    const recovery = formatAddTopLevelExportRecovery(config);

    it('should produce a non-empty recovery sentence', () => {
      expect(recovery.trim().length).toBeGreaterThan(0);
    });

    it('should embed the kernel topLevelExportExample verbatim', () => {
      expect(recovery).toContain(config.topLevelExportExample);
    });

    it('should tell the agent the file should render standalone', () => {
      expect(recovery).toMatch(/renders standalone/);
    });
  });
});
