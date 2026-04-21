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
