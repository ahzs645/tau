import tseslint from 'typescript-eslint';
import nxEslintPlugin from '@nx/eslint-plugin';
import * as importXPlugin from 'eslint-plugin-import-x';
import maxParamsNoConstructorPlugin from 'eslint-plugin-max-params-no-constructor';

/**
 * Minimal ESLint config -- only rules that cannot run in oxlint.
 *
 * Everything else (200+ rules) lives in .oxlintrc.json and runs via oxlint
 * before ESLint in the Nx lint target. Formatting is handled by oxfmt.
 */

// --- naming-convention helpers (replicate XO's config with URL/FS acronym mutations) ---

const namingConventionBase = [
  'error',
  {
    selector: [
      'variable',
      'function',
      'classProperty',
      'objectLiteralProperty',
      'parameterProperty',
      'classMethod',
      'objectLiteralMethod',
      'typeMethod',
      'accessor',
    ],
    format: ['camelCase'],
    leadingUnderscore: 'allowSingleOrDouble',
    trailingUnderscore: 'allow',
    filter: { regex: '(URL|FS)', match: true },
  },
  {
    selector: 'typeLike',
    format: ['PascalCase'],
    filter: { regex: '(URL|FS)', match: true },
  },
  {
    selector: [
      'variable',
      'function',
      'classProperty',
      'objectLiteralProperty',
      'parameterProperty',
      'classMethod',
      'objectLiteralMethod',
      'typeMethod',
      'accessor',
    ],
    format: ['strictCamelCase'],
    leadingUnderscore: 'allowSingleOrDouble',
    trailingUnderscore: 'allow',
    filter: { regex: '[- ]', match: false },
  },
  { selector: 'typeLike', format: ['StrictPascalCase'] },
  {
    selector: 'variable',
    types: ['boolean'],
    format: ['StrictPascalCase'],
    prefix: ['is', 'has', 'can', 'should', 'will', 'did'],
  },
  {
    selector: 'interface',
    filter: '^(?!I)[A-Z]',
    format: ['StrictPascalCase'],
  },
  {
    selector: 'typeParameter',
    filter: '^T$|^[A-Z][a-zA-Z]+$',
    format: ['StrictPascalCase'],
  },
  {
    selector: ['classProperty', 'objectLiteralProperty'],
    format: null,
    modifiers: ['requiresQuotes'],
  },
];

const namingConventionTsx = [
  'error',
  {
    ...namingConventionBase[1],
    format: ['camelCase', 'PascalCase'],
  },
  namingConventionBase[2],
  {
    ...namingConventionBase[3],
    format: ['strictCamelCase', 'StrictPascalCase'],
  },
  ...namingConventionBase.slice(4),
];

const memberOrdering = [
  'error',
  {
    default: [
      'signature',
      'public-static-field',
      'public-static-method',
      'protected-static-field',
      'protected-static-method',
      'private-static-field',
      'private-static-method',
      'static-field',
      'static-method',
      'public-decorated-field',
      'public-instance-field',
      'public-abstract-field',
      'public-field',
      'protected-decorated-field',
      'protected-instance-field',
      'protected-abstract-field',
      'protected-field',
      'private-decorated-field',
      'private-instance-field',
      'private-field',
      'instance-field',
      'abstract-field',
      'decorated-field',
      'field',
      'public-constructor',
      'protected-constructor',
      'private-constructor',
      'constructor',
      'public-decorated-method',
      'public-instance-method',
      'public-abstract-method',
      'public-method',
      'protected-decorated-method',
      'protected-instance-method',
      'protected-abstract-method',
      'protected-method',
      'private-decorated-method',
      'private-instance-method',
      'private-method',
      'instance-method',
      'abstract-method',
      'decorated-method',
      'method',
    ],
  },
];

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      '**/vite.config.{js,ts,mjs,mts,cjs,cts}.timestamp*',
      'node_modules',
      '.nx/cache',
      '.nx/workspace-data',
      '**/dist',
      '**/coverage/',
      '**/.cache',
      '**/build',
      '**/public/build',
      '**/public/*.js',
      '**/.env',
      '**/.react-router',
      '**/stats.html',
      '**/out-tsc',
      '**/generated',
      '**/assets',
      '**/.source/**/*',
      '**/.netlify',
      '**/*.prompt.example.*',
      '**/*.cjs',
      '**/*.jscad.js',
      '**/content/docs/**',
      '**/vitest.integration.config.ts',
      'tarballs/**',
      'experiments/**',
      '**/wasm/**',
    ],
  },

  {
    ...tseslint.configs.base,
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- parserOptions is a runtime-resolved object
    languageOptions: {
      ...tseslint.configs.base.languageOptions,
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- parserOptions is a runtime-resolved object
      parserOptions: {
        ...tseslint.configs.base.languageOptions?.parserOptions,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    plugins: { '@nx': nxEslintPlugin },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          allow: ['@taucad/kernels'],
          allowCircularSelfDependency: true,
          depConstraints: [
            {
              sourceTag: 'scope:api',
              onlyDependOnLibsWithTags: ['scope:shared', 'scope:api'],
            },
            {
              sourceTag: 'scope:ui',
              onlyDependOnLibsWithTags: ['scope:shared', 'scope:ui'],
            },
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:ui', 'type:lib', 'type:examples'],
            },
            {
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: ['type:ui', 'type:lib'],
            },
            {
              sourceTag: 'type:lib',
              onlyDependOnLibsWithTags: ['type:lib'],
            },
            {
              sourceTag: 'type:e2e',
              onlyDependOnLibsWithTags: ['type:app'],
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    plugins: { 'import-x': importXPlugin },
    rules: {
      '@typescript-eslint/naming-convention': namingConventionBase,
      '@typescript-eslint/member-ordering': memberOrdering,
      '@typescript-eslint/explicit-member-accessibility': 'error',
      // Enforce ES6 shorthand for object properties and methods (e.g. `{ args }` instead of `{ args: args }`).
      // TODO: Move to .oxlintrc.json once oxlint ships native `object-shorthand` (oxc-project/oxc#17688).
      'object-shorthand': ['error', 'always'],
      'id-denylist': ['error', 'temp', 'tmp', 'val', 'vals', 'obj', 'cb'],
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          packageDir: ['.', '../..'],
          devDependencies: true,
          optionalDependencies: false,
          peerDependencies: false,
          includeTypes: true,
        },
      ],
    },
  },

  {
    files: ['**/*.tsx'],
    rules: {
      '@typescript-eslint/naming-convention': namingConventionTsx,
    },
  },

  {
    files: [
      '**/*.controller.ts',
      '**/*.service.ts',
      '**/*.module.ts',
      '**/*.guard.ts',
      '**/*.gateway.ts',
      '**/*.interceptor.ts',
      '**/*.filter.ts',
      '**/*.pipe.ts',
      '**/*.provider.ts',
      '**/*.resolver.ts',
    ],
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- plugins is a runtime-resolved object
    plugins: { 'max-params-no-constructor': maxParamsNoConstructorPlugin },
    rules: {
      'max-params-no-constructor/max-params-no-constructor': ['error', 3],
    },
  },

  {
    files: ['packages/**/*.{ts,tsx}'],
    ignores: ['packages/**/*.{spec,test,config,setup}.{ts,tsx}'],
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          packageDir: ['.'],
          devDependencies: true,
          optionalDependencies: false,
          peerDependencies: true,
          includeTypes: true,
          includeInternal: true,
        },
      ],
    },
  },

  {
    files: ['libs/tau-examples/src/kernels/**/*.ts'],
    rules: {
      '@typescript-eslint/naming-convention': 'warn',
    },
  },
];

export default config;
