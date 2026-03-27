import { z } from 'zod';
import deepmerge from 'deepmerge';
import { defineMiddleware } from '@taucad/runtime/middleware';

const parametersFile = '.tau/parameters.json';
const parameterWatchDebounceMs = 200;

export const parameterFileResolverMiddleware = defineMiddleware({
  name: 'parameter-file-resolver',

  optionsSchema: z.object({
    parametersFile: z.string().default(parametersFile),
    watchDebounceMs: z.number().default(parameterWatchDebounceMs),
  }),

  getDependencies({ basePath }, options) {
    return [`${basePath}/${options.parametersFile}`];
  },

  async wrapCreateGeometry(input, handler, runtime) {
    const parametersPath = `${input.basePath}/${runtime.options.parametersFile}`;
    runtime.registerWatchPath(parametersPath, { debounceMs: runtime.options.watchDebounceMs });

    try {
      const content = await runtime.filesystem.readFile(parametersPath, 'utf8');
      const config: unknown = JSON.parse(content);

      if (
        typeof config !== 'object' ||
        config === null ||
        !('version' in config) ||
        (config as { version: unknown }).version !== 1 ||
        !('files' in config)
      ) {
        return await handler(input);
      }

      const { files } = config as { files: Record<string, unknown> };
      const relativePath = input.filePath.replace(`${input.basePath}/`, '');
      const fileEntry = files[relativePath] as
        | { activeSet: string; sets: Record<string, { values: Record<string, unknown> }> }
        | undefined;

      if (!fileEntry) {
        return await handler(input);
      }

      const activeSetValues = fileEntry.sets[fileEntry.activeSet]?.values;
      if (!activeSetValues) {
        return await handler(input);
      }
      return await handler({
        ...input,
        parameters: deepmerge(input.parameters, activeSetValues, {
          arrayMerge: (_target: unknown[], source: unknown[]) => source,
        }),
      });
    } catch {
      return handler(input);
    }
  },
});
