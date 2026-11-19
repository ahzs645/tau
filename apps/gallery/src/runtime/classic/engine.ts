import { createOpenSCAD } from 'openscad-wasm-prebuilt';
import type { ClassicOpenScadInstance } from '#runtime/classic/openscad-wasm.js';
import { withoutEmscriptenProcessListeners } from '@taucad/runtime/kernel';
import type { KernelIssue, RuntimeLogger } from '@taucad/runtime/kernel';
import type { ClassicFonts } from '#runtime/classic/fonts.js';
import { classicFontConfiguration } from '#runtime/classic/fonts.js';
import { classicParameterArguments } from '#runtime/classic/parameters.js';
import type { ClassicSources } from '#runtime/classic/sources.js';

export type ClassicNativeFormat = 'off' | 'stl' | 'param';
export type ClassicNativeOutput = Readonly<{ bytes: Uint8Array<ArrayBuffer>; issues: readonly KernelIssue[] }>;

export class ClassicBuildError extends Error {
  public readonly issues: readonly KernelIssue[];

  public constructor(issues: readonly KernelIssue[]) {
    super(issues.map(({ message }) => message).join('\n'));
    this.issues = issues;
  }
}

const failure = (message: string, entryPath: string): KernelIssue => ({
  message,
  code: 'RUNTIME',
  type: 'kernel',
  severity: 'error',
  location: { fileName: entryPath, startLineNumber: 1, startColumn: 1 },
});

const diagnostic = (message: string, entryPath: string): KernelIssue | undefined => {
  const kind = /^(ERROR|WARNING|Parser error):/iu.exec(message)?.[1]?.toUpperCase();
  if (!kind) {
    return undefined;
  }
  // Missing inputs can leave the engine reporting success with an incomplete union.
  const missingInput = /(?:can't|cannot|could not) open (?:include|library|import|input) file/iu.test(message);
  const sourceLocation = /\bin file (.+?), line (\d+)/u.exec(message);
  const fileName = (sourceLocation?.[1] ?? entryPath).replace(/^\/project\//u, '');
  return {
    message,
    code: 'RUNTIME',
    type: 'kernel',
    severity: kind === 'WARNING' && !missingInput ? 'warning' : 'error',
    location: { fileName, startLineNumber: Number(sourceLocation?.[2] ?? 1), startColumn: 1 },
  };
};

const makeDirectory = (instance: ClassicOpenScadInstance, path: string, created: Set<string>): void => {
  if (created.has(path)) {
    return;
  }
  try {
    instance.FS.mkdir(path);
  } catch (error) {
    // Emscripten may already provide its font/locale directories. Only accept a path that actually exists.
    try {
      instance.FS.stat(path);
    } catch {
      throw error;
    }
  }
  created.add(path);
};

const mountFile = (
  instance: ClassicOpenScadInstance,
  file: { path: string; bytes: string | Uint8Array<ArrayBuffer> },
  created: Set<string>,
): void => {
  const { path, bytes } = file;
  const segments = path.split('/').slice(1, -1);
  let directory = '';
  for (const segment of segments) {
    directory += `/${segment}`;
    makeDirectory(instance, directory, created);
  }
  instance.FS.writeFile(path, bytes);
};

const mountInputs = (instance: ClassicOpenScadInstance, sources: ClassicSources, fonts: ClassicFonts): void => {
  // These are the engine's standard pre-existing directories, not project capabilities.
  const created = new Set(['', '/']);
  makeDirectory(instance, '/project', created);
  makeDirectory(instance, '/output', created);
  for (const [path, bytes] of Object.entries(sources.files)) {
    mountFile(instance, { path: `/project/${path}`, bytes }, created);
  }
  for (const { name, bytes } of fonts) {
    mountFile(instance, { path: `/fonts/${name}`, bytes }, created);
  }
  makeDirectory(instance, '/fonts/cache', created);
  mountFile(instance, { path: '/fonts/fonts.conf', bytes: classicFontConfiguration }, created);
  mountFile(instance, { path: '/etc/fonts/fonts.conf', bytes: classicFontConfiguration }, created);
  if (instance.ENV) {
    instance.ENV['FONTCONFIG_FILE'] = '/etc/fonts/fonts.conf';
    instance.ENV['FONTCONFIG_PATH'] = '/etc/fonts';
    instance.ENV['OPENSCADPATH'] = '/project';
  }
  instance.FS.chdir('/project');
};

const nativeArguments = (
  sources: ClassicSources,
  format: ClassicNativeFormat,
  options: { parameters: Readonly<Record<string, unknown>>; resolution: Readonly<Record<string, number>> },
): { arguments: string[]; outputPath: string } => {
  const outputPath = `/output/model.${format === 'param' ? 'json' : format}`;
  const arguments_ = [sources.entryPath, '-o', outputPath, '--backend=manifold'];
  if (format === 'param') {
    arguments_.push('--export-format=param');
  } else if (format === 'stl') {
    arguments_.push('--export-format=binstl');
  }
  arguments_.push(...classicParameterArguments(options.parameters));
  arguments_.push(...Object.entries(options.resolution).map(([name, value]) => `-D${name}=${value}`));
  return { arguments: arguments_, outputPath };
};

/**
 * A fresh single-threaded engine for each CLI call. The package has no safe repeated-call or disposal API;
 * only copied output bytes escape this scope, so the WASM heap and filesystem become collectible afterward.
 * Browser worker termination and the Node parent watchdog enforce deadlines during synchronous callMain().
 */
export const runClassicOpenScad = async (input: {
  sources: ClassicSources;
  fonts: ClassicFonts;
  format: ClassicNativeFormat;
  parameters?: Readonly<Record<string, unknown>>;
  resolution?: Readonly<Record<string, number>>;
  signal: AbortSignal;
  logger: RuntimeLogger;
}): Promise<ClassicNativeOutput> => {
  const { sources, fonts, format, signal, logger } = input;
  signal.throwIfAborted();
  const issues: KernelIssue[] = [];
  const report = (message: string): void => {
    const issue = diagnostic(message, sources.entryPath);
    if (issue) {
      issues.push(issue);
      if (issue.severity === 'error') {
        logger.error(message);
      } else {
        logger.warn(message);
      }
    } else {
      logger.debug(message);
    }
  };
  const engine = await withoutEmscriptenProcessListeners(async () =>
    createOpenSCAD({ noInitialRun: true, print: report, printErr: report }),
  );
  signal.throwIfAborted();
  const instance = engine.getInstance();
  mountInputs(instance, sources, fonts);
  const { arguments: arguments_, outputPath } = nativeArguments(sources, format, {
    parameters: input.parameters ?? {},
    resolution: input.resolution ?? {},
  });
  let exitCode: number;
  try {
    exitCode = instance.callMain(arguments_);
  } catch (error) {
    signal.throwIfAborted();
    throw new ClassicBuildError([
      ...issues,
      failure(`OpenSCAD failed while producing ${format}: ${String(error)}`, sources.entryPath),
    ]);
  }
  signal.throwIfAborted();
  if (exitCode !== 0 || issues.some(({ severity }) => severity === 'error')) {
    throw new ClassicBuildError(
      issues.some(({ severity }) => severity === 'error')
        ? issues
        : [...issues, failure(`OpenSCAD exited with status ${exitCode} while producing ${format}.`, sources.entryPath)],
    );
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(instance.FS.readFile(outputPath, { encoding: 'binary' }));
  } catch (error) {
    throw new ClassicBuildError([
      ...issues,
      failure(`OpenSCAD produced no ${format} output: ${String(error)}`, sources.entryPath),
    ]);
  }
  if (bytes.byteLength === 0) {
    throw new ClassicBuildError([...issues, failure(`OpenSCAD produced an empty ${format} file.`, sources.entryPath)]);
  }
  return { bytes, issues };
};
