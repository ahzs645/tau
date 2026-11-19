import type { KernelIssue, KernelServices } from '@taucad/runtime/kernel';
import type { ClassicFonts } from '#runtime/classic/fonts.js';
import { runClassicOpenScad } from '#runtime/classic/engine.js';
import { parseClassicCustomizer } from '#runtime/classic/customizer.js';
import { parameterExportSchema } from '#runtime/classic/parameter-types.js';
import type { ClassicParameter, ClassicParameterExport } from '#runtime/classic/parameter-types.js';
import { classicCustomizerPaths, classicSourceText } from '#runtime/classic/sources.js';
import type { ClassicSources } from '#runtime/classic/sources.js';

const sourceGroup = (path: string): string => {
  const filename = path.slice(path.lastIndexOf('/') + 1).replace(/\.scad$/u, '');
  return filename.charAt(0).toUpperCase() + filename.slice(1);
};

/** Keep the fork's project-include controls, using the original engine for nonliteral defaults. */
export const describeClassicSources = async (
  sources: ClassicSources,
  fonts: ClassicFonts,
  services: Pick<KernelServices, 'signal' | 'logger'>,
): Promise<{ parameters: ClassicParameterExport; issues: KernelIssue[] }> => {
  const parameters: ClassicParameter[] = [];
  const issues: KernelIssue[] = [];
  for (const path of classicCustomizerPaths(sources)) {
    services.signal.throwIfAborted();
    let parsed = parseClassicCustomizer(classicSourceText(sources, path), path);
    if (!parsed) {
      // oxlint-disable-next-line no-await-in-loop -- each original CLI call owns a fresh WASM instance; bound peak memory.
      const native = await runClassicOpenScad({
        sources: { ...sources, entryPath: path },
        fonts,
        format: 'param',
        signal: services.signal,
        logger: services.logger,
      });
      const decoded: unknown = JSON.parse(new TextDecoder().decode(native.bytes));
      parsed = parameterExportSchema.parse(decoded);
      issues.push(...native.issues);
    }
    for (const parameter of parsed.parameters) {
      const defaultGroup = ['', 'Global', 'Parameters'].includes(parameter.group);
      parameters.push(
        path !== sources.entryPath && defaultGroup ? { ...parameter, group: sourceGroup(path) } : parameter,
      );
    }
  }
  return { parameters: { parameters, title: sources.entryPath }, issues };
};
