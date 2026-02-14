import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { shikiToMonaco } from '@shikijs/monaco';
import { registerCompletion } from 'monacopilot';
import type { CompletionRegistration, CompletionCopilot } from 'monacopilot';
import type * as Monaco from 'monaco-editor';
import { ENV } from '#environment.config.js';
import { highlighter } from '#lib/shiki.js';
import { registry } from '#lib/monaco-language-registry.js';
import { monacoLanguages } from '#lib/monaco.constants.js';
import { kclContribution } from '#lib/kcl-language/kcl-register-language.js';
import { openscadContribution } from '#lib/openscad-language/openscad-register-language.js';
import { jsTsContribution } from '#lib/javascript-contribution.js';

// Register contributions at module load (idempotent -- safe under HMR)
registry.addContribution(kclContribution);
registry.addContribution(openscadContribution);
registry.addContribution(jsTsContribution);

/**
 * Configure the Monaco editor.
 *
 * This custom loader supports Vite bundling and ensures a minimal
 * bundle size.
 */
export const configureMonaco = async (): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- can be undefined in SSR
  if (globalThis.self !== undefined) {
    globalThis.self.MonacoEnvironment = {
      getWorker(_, label) {
        if (label === 'json') {
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
    await import('monaco-editor/esm/vs/language/json/monaco.contribution.js');
    await import('monaco-editor/esm/vs/language/typescript/monaco.contribution.js');

    // Phase 1: Register language metadata for all contributions (idempotent)
    registry.registerAll(monaco);

    // Register Shiki highlighter ONCE globally. shikiToMonaco monkey-patches
    // monaco.editor.create and monaco.editor.setTheme, creating chained wrappers
    // on repeated calls. Calling it once here (instead of per-editor instance)
    // prevents wrapper multiplication that can interfere with editor creation.
    shikiToMonaco(highlighter, monaco);
  }
};

/**
 * Register completions for all supported Monaco languages.
 *
 * One completion provider is registered per language defined in
 * {@link monacoLanguages}. The returned {@link CompletionRegistration}
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
  const registrations: CompletionRegistration[] = Object.values(monacoLanguages).map((language) =>
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
