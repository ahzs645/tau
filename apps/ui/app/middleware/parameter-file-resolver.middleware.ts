import { z } from 'zod';
import deepmerge from 'deepmerge';
import { defineMiddleware } from '@taucad/runtime/middleware';

const parametersDir = '.tau/parameters';
const parameterWatchDebounceMs = 200;

export const parameterFileResolverMiddleware = defineMiddleware({
  name: 'parameter-file-resolver',

  optionsSchema: z.object({
    parametersDir: z.string().default(parametersDir),
    watchDebounceMs: z.number().default(parameterWatchDebounceMs),
  }),

  getDependencies({ filePath, basePath }, options) {
    const relativePath = filePath.replace(`${basePath}/`, '');
    return [`${basePath}/${options.parametersDir}/${relativePath}.json`];
  },

  async wrapCreateGeometry(input, handler, runtime) {
    const relativePath = input.filePath.replace(`${input.basePath}/`, '');
    const parametersPath = `${input.basePath}/${runtime.options.parametersDir}/${relativePath}.json`;
    runtime.registerWatchPath(parametersPath, { debounceMs: runtime.options.watchDebounceMs });

    try {
      const content = await runtime.filesystem.readFile(parametersPath, 'utf8');
      const entry: unknown = JSON.parse(content);

      if (typeof entry !== 'object' || entry === null || !('activeGroup' in entry) || !('groups' in entry)) {
        return await handler(input);
      }

      const { activeGroup, groups } = entry as {
        activeGroup: string;
        groups: Record<string, { values: Record<string, unknown> }>;
      };
      const activeGroupValues = groups[activeGroup]?.values;
      if (!activeGroupValues) {
        return await handler(input);
      }

      return await handler({
        ...input,
        parameters: deepmerge(input.parameters, activeGroupValues, {
          arrayMerge: (_target: unknown[], source: unknown[]) => source,
        }),
      });
    } catch {
      return handler(input);
    }
  },
});
