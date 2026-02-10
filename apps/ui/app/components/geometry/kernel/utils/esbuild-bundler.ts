/**
 * ESBuild Bundler
 *
 * Provides in-browser bundling using esbuild-wasm with custom plugins
 * for ZenFS filesystem integration and node_modules resolution.
 *
 * This bundler is designed to run in kernel workers and uses:
 * - A `builtin` namespace for pre-loaded modules served from memory (zero FS I/O)
 * - A `zenfs` namespace for project files and CDN-cached modules read from ZenFS
 * - ModuleManager for CDN module fetching and caching at root `/node_modules/`
 */

import * as esbuild from 'esbuild-wasm';
import type { Plugin, BuildResult, BuildOptions, Message } from 'esbuild-wasm';
import type { KernelFilesystem, KernelIssue } from '@taucad/types';
import type { BuiltinModule } from '#components/geometry/kernel/utils/module-manager.js';
import { ModuleManager } from '#components/geometry/kernel/utils/module-manager.js';
import { isBareSpecifier, parsePackageSpecifier, getCdnCachePath, resolveRelativePath } from '#utils/import.utils.js';

// =============================================================================
// Types
// =============================================================================

export type BundleResult = {
  /** The bundled code as a string */
  code: string;
  /** Source map (if enabled) */
  sourceMap?: string;
  /** Compilation issues (errors, warnings) */
  issues: KernelIssue[];
  /** Whether bundling succeeded */
  success: boolean;
};

export type BundlerOptions = {
  /** Filesystem interface for reading/writing files */
  filesystem: KernelFilesystem;
  /** Base path for the project (e.g., /builds/project) */
  projectPath: string;
  /** Built-in modules to use as fallback */
  builtinModules: Map<string, BuiltinModule>;
  /** Enable source maps */
  sourceMaps?: boolean;
  /**
   * Names to auto-export from CommonJS-style entry files.
   * When code defines these as globals but doesn't export them,
   * the bundler adds `export { ... }` statements to prevent tree-shaking.
   * Defaults to `['main', 'defaultParams']`.
   */
  autoExportNames?: string[];
};

// =============================================================================
// WASM Configuration
// =============================================================================

// WASM URL using universal pattern for browsers and bundlers
// WASM file is copied from node_modules via copy-files-from-to
// @see https://web.dev/articles/bundling-non-js-resources#universal_pattern_for_browsers_and_bundlers
const esbuildWasmUrl = new URL('wasm/esbuild.wasm', import.meta.url).href;

// Detect Node.js environment (process.versions.node exists in Node.js)
// eslint-disable-next-line n/prefer-global/process, @typescript-eslint/no-unnecessary-condition -- process may be undefined in browser
const isNodejs = typeof process !== 'undefined' && Boolean(process.versions?.node);

// =============================================================================
// State
// =============================================================================

let esbuildInitialized = false;
let initializationPromise: Promise<void> | undefined;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize esbuild-wasm. This must be called before bundling.
 * The initialization is cached - subsequent calls return immediately.
 *
 * Uses isomorphic initialization:
 * - Browser/Worker: wasmURL (fetches WASM via network from bundled file)
 * - Node.js: No options (uses child process to run native esbuild binary)
 */
export async function initializeEsbuild(): Promise<void> {
  if (esbuildInitialized) {
    return;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async (): Promise<void> => {
    try {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- esbuild API uses wasmURL
      await esbuild.initialize(isNodejs ? {} : { wasmURL: esbuildWasmUrl });

      esbuildInitialized = true;
    } catch (error) {
      initializationPromise = undefined;
      throw error;
    }
  })();

  return initializationPromise;
}

// =============================================================================
// Plugins
// =============================================================================

/** Default names to auto-export from CommonJS-style entry files */
const defaultAutoExportNames = ['main', 'defaultParams'];

/**
 * Add CommonJS-style exports to source code if needed.
 *
 * When code defines any of the `names` as globals but doesn't export them,
 * this function adds the necessary export statements at the end of the code.
 *
 * This must be done at the source level (before bundling) to prevent esbuild
 * from tree-shaking away the unexported functions.
 *
 * Special handling for `main`: if `export default` already exists, `main` is
 * considered exported and won't be added again.
 *
 * @param code - The source code to transform
 * @param names - List of symbol names to auto-export
 * @returns The transformed code with exports added if needed
 */
function addCommonJsExports(code: string, names: string[]): string {
  const exportsToAdd: string[] = [];

  for (const name of names) {
    // Check if already exported
    const hasNamedExport =
      new RegExp(`\\bexport\\s+\\{\\s*[^}]*\\b${name}\\b`).test(code) ||
      new RegExp(`\\bexport\\s+(const|function|let|var)\\s+${name}\\b`).test(code);

    if (hasNamedExport) {
      continue;
    }

    // Special case: `main` is considered exported if `export default` exists
    if (name === 'main' && /\bexport\s+default\b/.test(code)) {
      continue;
    }

    // Check if code defines this symbol (not exported)
    const defines =
      new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(code) ||
      new RegExp(`\\b(const|let|var)\\s+${name}\\s*=`).test(code);

    if (defines) {
      exportsToAdd.push(name);
    }
  }

  if (exportsToAdd.length > 0) {
    return code + `\nexport { ${exportsToAdd.join(', ')} };\n`;
  }

  return code;
}

// =============================================================================
// Plugin Helpers
// =============================================================================

/**
 * Resolve file extension for imports without extension.
 * Needs filesystem access, so it lives inside the plugin scope.
 */
async function resolveFileExtension(filesystem: KernelFilesystem, path: string): Promise<string> {
  // If already has extension, return as-is
  if (/\.[jt]sx?$/.test(path)) {
    return path;
  }

  // Try common extensions in order
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];

  for (const extension of extensions) {
    const fullPath = path + extension;
    // eslint-disable-next-line no-await-in-loop -- Intentional: short-circuits on first match
    if (await filesystem.exists(fullPath)) {
      return fullPath;
    }
  }

  // Return original path if no extension found
  return path;
}

/**
 * Determine the esbuild loader based on file extension.
 */
function getLoader(filePath: string): 'ts' | 'tsx' | 'js' | 'jsx' | 'json' | 'text' {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (extension) {
    case 'ts': {
      return 'ts';
    }

    case 'tsx': {
      return 'tsx';
    }

    case 'jsx': {
      return 'jsx';
    }

    case 'json': {
      return 'json';
    }

    default: {
      return 'js';
    }
  }
}

// =============================================================================
// ZenFS Plugin
// =============================================================================

type ZenFsPluginOptions = {
  filesystem: KernelFilesystem;
  moduleManager: ModuleManager;
  builtinModules: Map<string, BuiltinModule>;
  projectPath: string;
  entryPath: string;
  autoExportNames: string[];
};

/**
 * Create a plugin that resolves and loads files from the ZenFS filesystem.
 *
 * Architecture:
 * - `builtin` namespace: Built-in modules served directly from memory (zero FS I/O)
 * - `zenfs` namespace: Project files and CDN-cached modules read from ZenFS
 * - `http-url` namespace: HTTP/HTTPS URLs fetched on demand
 *
 * Bare specifier resolution:
 * 1. Builtins (replicad, jscad, zod) -> `builtin` namespace (memory)
 * 2. CDN modules -> ensure cached at `/node_modules/`, then `zenfs` namespace
 * 3. Relative/absolute imports -> resolved via filesystem with extension probing
 */
function createZenFsPlugin(options: ZenFsPluginOptions): Plugin {
  const { filesystem, moduleManager, builtinModules, projectPath, entryPath, autoExportNames } = options;
  return {
    name: 'zenfs',
    setup(build) {
      // -----------------------------------------------------------------
      // onResolve: entry points
      // -----------------------------------------------------------------
      build.onResolve({ filter: /.*/ }, async (args) => {
        // Skip if it's the entry point
        if (args.kind === 'entry-point') {
          return { path: args.path, namespace: 'zenfs' };
        }

        // Handle data: URLs (esbuild internal)
        if (args.path.startsWith('data:')) {
          return { external: true };
        }

        // Handle http/https URLs - fetch and bundle them
        if (args.path.startsWith('http://') || args.path.startsWith('https://')) {
          return { path: args.path, namespace: 'http-url' };
        }

        // --- Bare specifiers ---
        if (isBareSpecifier(args.path)) {
          const pkgInfo = parsePackageSpecifier(args.path);

          // Builtins: check full specifier first (e.g., '@jscad/modeling/primitives'),
          // then fall back to root package name (e.g., '@jscad/modeling')
          const fullSpecifier = pkgInfo.path ? `${pkgInfo.name}/${pkgInfo.path}` : pkgInfo.name;
          if (builtinModules.has(fullSpecifier)) {
            return { path: fullSpecifier, namespace: 'builtin' };
          }

          if (builtinModules.has(pkgInfo.name)) {
            return { path: pkgInfo.name, namespace: 'builtin' };
          }

          // CDN modules: ensure cached at root /node_modules/, return zenfs path
          try {
            const cachePath = getCdnCachePath(pkgInfo.name, pkgInfo.path || undefined);
            await moduleManager.ensureCdnModule(pkgInfo.name, pkgInfo.path || undefined);
            return { path: cachePath, namespace: 'zenfs' };
          } catch (error) {
            return {
              errors: [
                {
                  text: `Failed to resolve '${args.path}': ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        }

        // --- Relative / absolute imports ---
        const importerPath = args.importer || `${projectPath}/entry.ts`;

        try {
          const resolvedPath = resolveRelativePath(args.path, importerPath);
          const withExtension = await resolveFileExtension(filesystem, resolvedPath);
          return { path: withExtension, namespace: 'zenfs' };
        } catch (error) {
          return {
            errors: [
              {
                text: `Failed to resolve '${args.path}': ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      });

      // -----------------------------------------------------------------
      // onLoad: builtin namespace (serve from memory)
      // -----------------------------------------------------------------
      build.onLoad({ filter: /.*/, namespace: 'builtin' }, (args) => {
        const builtin = builtinModules.get(args.path);
        if (!builtin) {
          return { errors: [{ text: `Built-in module '${args.path}' not found` }] };
        }

        return { contents: builtin.code, loader: 'js' };
      });

      // -----------------------------------------------------------------
      // onLoad: HTTP/HTTPS URLs
      // -----------------------------------------------------------------
      build.onLoad({ filter: /.*/, namespace: 'http-url' }, async (args) => {
        try {
          const response = await fetch(args.path);
          if (!response.ok) {
            return {
              errors: [{ text: `Failed to fetch '${args.path}': ${response.status} ${response.statusText}` }],
            };
          }

          const contents = await response.text();
          const loader = getLoader(new URL(args.path).pathname);

          return {
            contents,
            loader,
            // Use the URL's directory for resolving relative imports within the fetched module
            resolveDir: new URL('./', args.path).href,
          };
        } catch (error) {
          return {
            errors: [
              { text: `Failed to fetch '${args.path}': ${error instanceof Error ? error.message : String(error)}` },
            ],
          };
        }
      });

      // -----------------------------------------------------------------
      // onResolve: relative imports within HTTP modules
      // -----------------------------------------------------------------
      build.onResolve({ filter: /^\./, namespace: 'http-url' }, (args) => {
        const resolvedUrl = new URL(args.path, args.resolveDir).href;
        return { path: resolvedUrl, namespace: 'http-url' };
      });

      // -----------------------------------------------------------------
      // onResolve: bare imports within HTTP modules
      // -----------------------------------------------------------------
      build.onResolve({ filter: /^[^./]/, namespace: 'http-url' }, (args) => {
        try {
          const baseUrl = new URL(args.resolveDir);
          const resolvedUrl = new URL(args.path, baseUrl.origin + '/').href;
          return { path: resolvedUrl, namespace: 'http-url' };
        } catch {
          return { external: true };
        }
      });

      // -----------------------------------------------------------------
      // onLoad: zenfs namespace (project files + CDN cache)
      // -----------------------------------------------------------------
      build.onLoad({ filter: /.*/, namespace: 'zenfs' }, async (args) => {
        try {
          let content = await filesystem.readFile(args.path, 'utf8');
          const loader = getLoader(args.path);

          // For the entry file (not node_modules), add CommonJS exports if needed
          // This prevents esbuild from tree-shaking away unexported main/defaultParams
          const isEntryFile = args.path === entryPath;
          const isNodeModules = args.path.includes('/node_modules/');

          if (isEntryFile && !isNodeModules && (loader === 'js' || loader === 'ts')) {
            content = addCommonJsExports(content, autoExportNames);
          }

          return {
            contents: content,
            loader,
            resolveDir: args.path.slice(0, args.path.lastIndexOf('/')),
          };
        } catch (error) {
          return {
            errors: [
              {
                text: `Failed to load '${args.path}': ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      });
    },
  };
}

// =============================================================================
// Bundler Class
// =============================================================================

export class EsbuildBundler {
  private readonly filesystem: KernelFilesystem;
  private readonly projectPath: string;
  private readonly builtinModules: Map<string, BuiltinModule>;
  private readonly moduleManager: ModuleManager;
  private readonly sourceMaps: boolean;
  private readonly autoExportNames: string[];

  public constructor(options: BundlerOptions) {
    this.filesystem = options.filesystem;
    this.projectPath = options.projectPath;
    this.builtinModules = options.builtinModules;
    this.sourceMaps = options.sourceMaps ?? true;
    this.autoExportNames = options.autoExportNames ?? defaultAutoExportNames;

    this.moduleManager = new ModuleManager(options.filesystem);
  }

  /**
   * Get the project path this bundler was configured for.
   */
  public getProjectPath(): string {
    return this.projectPath;
  }

  /**
   * Initialize the bundler (must be called before bundling).
   */
  public async initialize(): Promise<void> {
    await initializeEsbuild();
  }

  /**
   * Dispose of the bundler and release resources.
   */
  public dispose(): void {
    this.moduleManager.clearCaches();
  }

  /**
   * Bundle a file and all its dependencies.
   *
   * @param entryPath - Absolute path to the entry file
   * @returns Bundle result with code and any issues
   */
  public async bundle(entryPath: string): Promise<BundleResult> {
    const issues: KernelIssue[] = [];

    try {
      // Create banner to inject CommonJS-style globals for built-in modules
      // This allows code like `const { draw } = replicad;` to work without imports
      // Only root modules with a globalName are included (not submodules)
      // Also define module/exports objects to prevent runtime errors in CommonJS-style code
      const moduleGlobals = [...this.builtinModules.entries()]
        .filter(([, mod]) => mod.globalName)
        .map(([name, mod]) => `const ${mod.globalName} = globalThis.__KERNEL_MODULES__?.get(${JSON.stringify(name)});`)
        .join('\n');
      const commonjsBanner = `${moduleGlobals}
const exports = {};
const module = { exports };
`;

      const buildOptions: BuildOptions = {
        entryPoints: [entryPath],
        bundle: true,
        write: false,
        format: 'esm',
        target: 'es2022',
        sourcemap: this.sourceMaps ? 'inline' : false,
        platform: 'browser',
        plugins: [
          createZenFsPlugin({
            filesystem: this.filesystem,
            moduleManager: this.moduleManager,
            builtinModules: this.builtinModules,
            projectPath: this.projectPath,
            entryPath,
            autoExportNames: this.autoExportNames,
          }),
        ],
        // Ensure we don't try to resolve node built-ins
        external: [],
        logLevel: 'silent',
        banner: { js: commonjsBanner },
      };

      const result: BuildResult = await esbuild.build(buildOptions);

      // Collect warnings
      for (const warning of result.warnings) {
        issues.push(this.convertEsbuildMessage(warning, 'warning'));
      }

      // Collect errors
      for (const error of result.errors) {
        issues.push(this.convertEsbuildMessage(error, 'error'));
      }

      // Get output
      if (result.outputFiles && result.outputFiles.length > 0) {
        const output = result.outputFiles[0]!;
        return {
          code: output.text,
          issues,
          success: result.errors.length === 0,
        };
      }

      return {
        code: '',
        issues: [
          ...issues,
          {
            message: 'No output generated',
            type: 'compilation',
            severity: 'error',
          },
        ],
        success: false,
      };
    } catch (error) {
      // Handle build errors
      if (error && typeof error === 'object' && 'errors' in error) {
        const buildErrors = error as { errors: Message[]; warnings: Message[] };

        for (const errorMessage of buildErrors.errors) {
          issues.push(this.convertEsbuildMessage(errorMessage, 'error'));
        }

        for (const warningMessage of buildErrors.warnings) {
          issues.push(this.convertEsbuildMessage(warningMessage, 'warning'));
        }
      } else {
        issues.push({
          message: error instanceof Error ? error.message : String(error),
          type: 'compilation',
          severity: 'error',
        });
      }

      return {
        code: '',
        issues,
        success: false,
      };
    }
  }

  /**
   * Convert an esbuild message to a KernelIssue.
   */
  private convertEsbuildMessage(message: Message, severity: 'error' | 'warning'): KernelIssue {
    const issue: KernelIssue = {
      message: message.text,
      type: 'compilation',
      severity,
    };

    if (message.location) {
      issue.location = {
        fileName: message.location.file,
        startLineNumber: message.location.line,
        startColumn: message.location.column,
      };
    }

    return issue;
  }
}
