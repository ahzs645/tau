import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { shikiToMonaco, textmateThemeToMonacoTheme } from '@shikijs/monaco';
import { registerCompletion } from 'monacopilot';
import type { CompletionRegistration, CompletionCopilot } from 'monacopilot';
import type * as Monaco from 'monaco-editor';
import { ENV } from '#environment.config.js';
import {
  createJsonTokensProvider,
  generateJsonBracketHighlightColors,
  generateJsonThemeRules,
} from '#lib/monaco-json.lib.js';
import { highlighter } from '#lib/shiki.lib.js';
import { registry } from '#lib/monaco-language-registry.js';
import { monacoLanguages } from '#lib/monaco.constants.js';
import { kclContribution } from '#lib/kcl-language/kcl-register-language.js';
import { openscadContribution } from '#lib/openscad-language/openscad-register-language.js';
import { stepfileContribution } from '#lib/stepfile-language/stepfile-register-language.js';
import { stlContribution } from '#lib/stl-language/stl-register-language.js';
import { usdContribution } from '#lib/usd-language/usd-register-language.js';
import { jsTsContribution } from '#lib/javascript-contribution.js';

// Register contributions at module load (idempotent -- safe under HMR)
registry.addContribution(kclContribution);
registry.addContribution(openscadContribution);
registry.addContribution(stepfileContribution);
registry.addContribution(stlContribution);
registry.addContribution(usdContribution);
registry.addContribution(jsTsContribution);

// Guard to ensure configureMonaco runs only once. shikiToMonaco monkey-patches
// monaco.editor.create and monaco.editor.setTheme, creating chained wrappers
// on repeated calls. This flag prevents that during HMR or multiple call sites.
let isConfigured = false;

/**
 * Configure the Monaco editor.
 *
 * This custom loader supports Vite bundling and ensures a minimal
 * bundle size. Idempotent -- safe to call from multiple entry points.
 */
export const configureMonaco = async (): Promise<void> => {
  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- can be undefined in SSR
  if (isConfigured || globalThis.self === undefined) {
    return;
  }

  isConfigured = true;

  globalThis.self.MonacoEnvironment = {
    getWorker(_, label) {
      if (label === 'json' || label === 'jsonc') {
        return new JsonWorker();
      }

      if (label === 'typescript' || label === 'javascript') {
        return new TsWorker();
      }

      return new EditorWorker();
    },
  };

  const monaco = await import('monaco-editor');

  loader.config({
    monaco,
  });

  // Core Editor features, like auto-completion.
  // @ts-expect-error -- no declaration file
  await import('monaco-editor/esm/vs/editor/edcore.main.js');

  // Languages
  await import('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js');
  await import('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js');
  // Capture jsonDefaults to disable the built-in JSON tokenizer below.
  // Monaco's ESM .d.ts for this contribution declares only `export {}`, but
  // the module exposes `jsonDefaults` at runtime.
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- empty .d.ts from third-party
  const { jsonDefaults } = (await import('monaco-editor/esm/vs/language/json/monaco.contribution.js')) as unknown as {
    jsonDefaults: {
      readonly modeConfiguration: Record<string, boolean>;
      setModeConfiguration(config: Record<string, boolean>): void;
    };
  };
  await import('monaco-editor/esm/vs/language/typescript/monaco.contribution.js');

  // Disable Monaco's built-in JSON tokenizer. The JSON mode contribution
  // lazily calls setupMode → registerProviders on first language encounter
  // (via `languages.onLanguage("json", ...)`), which registers a competing
  // tokenizer via setTokensProvider when `tokens: true`. This overrides our
  // Shiki-based tokenizer asynchronously, causing a visible flicker from
  // correct colors back to the default palette.
  jsonDefaults.setModeConfiguration({
    ...jsonDefaults.modeConfiguration,
    tokens: false,
  });

  // Phase 1: Register language metadata for all contributions (idempotent)
  registry.registerAll(monaco);

  // Register Shiki highlighter globally. The idempotency guard above ensures
  // this only runs once, preventing monkey-patch wrapper multiplication on
  // monaco.editor.create and monaco.editor.setTheme.
  shikiToMonaco(highlighter, monaco);

  // Override Shiki's JSON tokenizer to preserve TextMate scope granularity
  // and add depth-based key colorization.
  const jsonGrammar = highlighter.getLanguage('json');
  const jsonTokensProvider = createJsonTokensProvider(jsonGrammar);
  monaco.languages.setTokensProvider('json', jsonTokensProvider);

  // JSONL (newline-delimited JSON): register as a distinct language so it
  // gets JSON syntax highlighting without the JSON language service validation
  // that would flag multi-root documents as errors.
  monaco.languages.register({ id: 'jsonl', aliases: ['JSON Lines'], extensions: ['.jsonl'] });
  monaco.languages.setTokensProvider('jsonl', jsonTokensProvider);

  // Augment GitHub themes with JSON-specific depth and value rules
  // derived from each theme's own scope colors.
  for (const themeId of ['github-dark', 'github-light'] as const) {
    const shikiTheme = highlighter.getTheme(themeId);
    // MonacoTheme extends monaco-editor-core's IStandaloneThemeData which is
    // structurally identical to monaco-editor's but TypeScript can't unify
    // the two package namespaces.
    const monacoTheme = textmateThemeToMonacoTheme(shikiTheme) as unknown as Monaco.editor.IStandaloneThemeData;
    monacoTheme.rules.push(...generateJsonThemeRules(shikiTheme));
    Object.assign(monacoTheme.colors, generateJsonBracketHighlightColors(shikiTheme));
    monaco.editor.defineTheme(themeId, monacoTheme);
  }
};

/**
 * Languages that should use monacopilot AI code completion.
 *
 * KCL and OpenSCAD register their own completion providers via language
 * contributions ({@link kclContribution}, {@link openscadContribution}).
 * Binary/non-code formats (stepfile, stl, usd) don't need AI completion.
 */
export const completionLanguages = [
  monacoLanguages.typescript,
  monacoLanguages.typescriptreact,
  monacoLanguages.javascript,
  monacoLanguages.javascriptreact,
  monacoLanguages.json,
] as const;

/**
 * Register completions for languages that use monacopilot AI code completion.
 *
 * One completion provider is registered per language defined in
 * {@link completionLanguages}. The returned {@link CompletionRegistration}
 * aggregates every individual registration so the caller can
 * deregister, trigger, or update options for all of them at once.
 *
 * @param editor - The editor instance.
 * @param monaco - The Monaco instance.
 * @returns A combined completion registration for all languages.
 */
export const registerCompletions = (
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
): CompletionRegistration => {
  const registrations: CompletionRegistration[] = completionLanguages.map((language) =>
    registerCompletion(monaco, editor, {
      endpoint: `${ENV.TAU_API_URL}/v1/code-completion`,
      language,
      trigger: 'onTyping',
      async requestHandler(request) {
        const response = await fetch(`${ENV.TAU_API_URL}/v1/code-completion`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request.body),
          credentials: 'include',
        });
        const data = (await response.json()) as Awaited<ReturnType<CompletionCopilot['complete']>>;

        return data;
      },
    }),
  );

  return {
    trigger() {
      for (const registration of registrations) {
        registration.trigger();
      }
    },
    deregister() {
      for (const registration of registrations) {
        registration.deregister();
      }
    },
    updateOptions(callback) {
      for (const registration of registrations) {
        registration.updateOptions(callback);
      }
    },
  };
};
