/**
 * NX Plugin for generating CJS type declarations (.d.cts).
 *
 * tsdown with `unbundle: true` cannot generate CJS DTS due to a rolldown plugin conflict.
 * This plugin creates a `generate-cjs-dts` target for all packages that have a tsdown config,
 * which copies ESM `.d.ts` files to CJS `.d.cts` equivalents post-build.
 */
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { CreateNodesResult, CreateNodesV2 } from '@nx/devkit';

const createTarget = (configFilePath: string): CreateNodesResult | undefined => {
  const projectRoot = dirname(configFilePath);

  if (projectRoot === '.') {
    return undefined;
  }

  if (!existsSync(join(projectRoot, 'package.json'))) {
    return undefined;
  }

  return {
    projects: {
      [projectRoot]: {
        targets: {
          'generate-cjs-dts': {
            executor: 'nx:run-commands',
            cache: true,
            dependsOn: ['build'],
            options: {
              command: `tsx tools/generate-cjs-dts.ts ${projectRoot}`,
              cwd: '.',
            },
            inputs: [
              '{projectRoot}/dist/esm/**/*.d.ts',
              {
                externalDependencies: ['tsx'],
              },
            ],
            outputs: ['{projectRoot}/dist/cjs/**/*.d.cts'],
          },
        },
      },
    },
  };
};

export const createNodesV2: CreateNodesV2 = [
  '**/tsdown.config.ts',
  // oxlint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- not necessary as already has an explicit return type
  (configFiles, _options) => {
    const results: Array<[string, CreateNodesResult]> = [];

    for (const configFile of configFiles) {
      const target = createTarget(configFile);
      if (target) {
        results.push([configFile, target]);
      }
    }

    return results;
  },
];
