import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageJson = {
  readonly version?: unknown;
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(scriptDirectory, '..');
const workspaceRoot = join(uiRoot, '../..');
const packageJsonPath = join(uiRoot, 'package.json');

const readArgument = (name: string): string | undefined => {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const isPlaceholder = process.argv.includes('--placeholder');
const outputDirectory = join(uiRoot, readArgument('--output') ?? 'public');
const versionJsonPath = join(outputDirectory, 'version.json');
const versionScriptPath = join(outputDirectory, 'version.js');

const commitEnvNames = [
  'VITE_COMMIT_SHA',
  'GITHUB_SHA',
  'COMMIT_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'NETLIFY_COMMIT_REF',
  'CF_PAGES_COMMIT_SHA',
] as const;

const branchEnvNames = [
  'VITE_GIT_BRANCH',
  'GITHUB_REF_NAME',
  'BRANCH',
  'VERCEL_GIT_COMMIT_REF',
  'HEAD',
  'CF_PAGES_BRANCH',
] as const;

const readPackageVersion = (): string => {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const firstEnvValue = (names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
};

const gitOutput = (command: string): string | undefined => {
  try {
    return execSync(command, { cwd: workspaceRoot, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

const commitSha = isPlaceholder ? 'dev' : (firstEnvValue(commitEnvNames) ?? gitOutput('git rev-parse HEAD') ?? 'dev');
const buildNumber = commitSha === 'dev' ? 'dev' : commitSha.slice(0, 7);
const buildTime = isPlaceholder
  ? 'dev'
  : (process.env['VITE_BUILD_TIME']?.trim() ?? process.env['BUILD_TIME']?.trim() ?? new Date().toISOString());
const branch = isPlaceholder ? undefined : (firstEnvValue(branchEnvNames) ?? gitOutput('git branch --show-current'));
const version = readPackageVersion();

const versionJson = {
  version,
  buildNumber,
  commit: commitSha,
  commitSha,
  ...(branch ? { branch } : {}),
  builtAt: buildTime,
  buildTime,
};

if (!existsSync(outputDirectory)) {
  mkdirSync(outputDirectory, { recursive: true });
}

writeFileSync(versionJsonPath, `${JSON.stringify(versionJson, null, 2)}\n`);
writeFileSync(versionScriptPath, `globalThis.tauBuildMetadata=${JSON.stringify(versionJson)};\n`);

console.log(`[ui:build-version] Generated version metadata ${version} (${buildNumber}) at ${buildTime}`);
