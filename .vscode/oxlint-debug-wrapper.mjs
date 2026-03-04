import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const defaultRuntimeLog = '/tmp/oxlint-runtime.log';
const defaultPanicLog = '/tmp/oxlint-panic.log';

// Opt-in runtime breadcrumbs from patched oxlint Rust code.
const runtimeDebugEnv = process.env.OXLINT_RUNTIME_DEBUG;
if (!runtimeDebugEnv || runtimeDebugEnv === '1' || runtimeDebugEnv.toLowerCase() === 'true') {
  process.env.OXLINT_RUNTIME_DEBUG = defaultRuntimeLog;
}

// Panic hook dump target from patched oxlint Rust code.
const panicLogEnv = process.env.OXLINT_PANIC_LOG;
if (!panicLogEnv || panicLogEnv === '1' || panicLogEnv.toLowerCase() === 'true') {
  process.env.OXLINT_PANIC_LOG = defaultPanicLog;
}

const oxlintMain = require.resolve('oxlint');
const cliPath = path.join(path.dirname(oxlintMain), 'cli.js');
await import(pathToFileURL(cliPath).href);
