import { Injectable } from '@nestjs/common';
import { cerebras } from '@ai-sdk/cerebras';
import { generateText } from 'ai';
import { CompletionCopilot } from 'monacopilot';
import type { CompletionRequestBody, CompletionMetadata } from 'monacopilot';
import { Span } from '#telemetry/tracer.service.js';

const cursorMarker = '{{CURSOR}}';

/**
 * Build a system-level context string from completion metadata.
 *
 * Includes technology stack, filename, and language so the model can tailor
 * completions to the project.
 */
function buildContext(metadata: CompletionMetadata): string {
  const { language, filename, technologies = [] } = metadata;

  const parts = [
    language ? `Language: ${language}` : '',
    filename ? `File: ${filename}` : '',
    technologies.length > 0 ? `Technology stack: ${technologies.join(', ')}` : '',
  ].filter(Boolean);

  return parts.join('\n');
}

/**
 * Build the instruction prompt for inline code completion.
 *
 * The instruction is carefully tuned for non-FIM models (e.g. Llama 3.3 70b)
 * that receive a chat-style prompt rather than fill-in-the-middle tokens.
 *
 * Key constraints enforced:
 * - Output ONLY the raw code to insert — no markdown fences, explanations, or surrounding code.
 * - Preserve the exact indentation level of the cursor line.
 * - Do NOT duplicate code that already exists before or after the cursor.
 * - A completion may be empty if the code is already complete.
 *
 * @see https://monacopilot.dev/advanced/custom-prompt.html
 * @see https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts
 */
function buildInstruction(): string {
  // Few-shot examples are the most reliable way to teach non-FIM models
  // (like Llama 3.3) the exact output format, especially for whitespace.
  // See: https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts
  return [
    `You are a HOLE FILLER. You are provided with a file containing a hole, marked by ${cursorMarker}. Your output is the exact text that should replace ${cursorMarker}, character-for-character, including all necessary newlines and indentation.`,
    '',
    'RULES:',
    '- Output ONLY the raw text to replace the hole — nothing else.',
    '- Do NOT include explanations, markdown fences, backticks, or comments about the completion.',
    '- Do NOT repeat code that already appears before or after the hole.',
    `- Your output will be spliced into the file at the exact position of ${cursorMarker}. If the hole is at the end of a line and new code belongs on the next line, your output MUST begin with a newline character ("\\n") followed by correct indentation.`,
    '- Match the indentation style (tabs vs spaces, width) of the surrounding code.',
    '- Keep completions concise — finish the current logical statement or block, then stop.',
    '- If no code is needed, output nothing.',
    '',
    'EXAMPLES (each <output> block is shown EXACTLY as it should be emitted, preserving all whitespace):',
    '',
    `Example 1 — cursor at end of a statement:`,
    `<input>console.log("hello");${cursorMarker}</input>`,
    '<output>',
    'console.log("world");',
    '</output>',
    '',
    `Example 2 — cursor mid-expression:`,
    `<input>const x = 1 +${cursorMarker};</input>`,
    '<output> 2</output>',
    '',
    `Example 3 — cursor at end of line inside a block:`,
    '<input>',
    'function greet() {',
    `  console.log("hi");${cursorMarker}`,
    '}',
    '</input>',
    '<output>',
    '  console.log("bye");',
    '</output>',
    '',
    `Example 4 — cursor after an opening brace:`,
    '<input>',
    `if (condition) {${cursorMarker}`,
    '}',
    '</input>',
    '<output>',
    '  doSomething();',
    '</output>',
    '',
    'IMPORTANT: In examples 1, 3 and 4 the output starts with a newline. The newline is part of the output because new code must go on its own line. In example 2 the output does NOT start with a newline because it continues the same expression.',
    '',
    'Now complete the file below. Emit ONLY the replacement text — no <output> tags.',
  ].join('\n');
}

/**
 * Build the file-content representation with a cursor marker.
 */
function buildFileContent(metadata: CompletionMetadata): string {
  const { textBeforeCursor, textAfterCursor } = metadata;

  return `${textBeforeCursor}${cursorMarker}${textAfterCursor}`;
}

@Injectable()
export class CodeCompletionService {
  private readonly copilot: CompletionCopilot;

  public constructor() {
    this.copilot = new CompletionCopilot(undefined, {
      async model(prompt) {
        const { text } = await generateText({
          // Llama 3.3 70b via Cerebras — fast inference with strong code understanding
          model: cerebras('llama-3.3-70b'),
          system: prompt.context,
          prompt: [
            '<instructions>',
            prompt.instruction,
            '</instructions>',
            '<file>',
            prompt.fileContent,
            '</file>',
          ].join('\n'),
          temperature: 0,
          maxOutputTokens: 256,
        });

        return { text };
      },
    });
  }

  @Span()
  public async complete(body: CompletionRequestBody): Promise<unknown> {
    return this.copilot.complete({
      options: {
        customPrompt: (metadata) => ({
          context: buildContext(metadata),
          instruction: buildInstruction(),
          fileContent: buildFileContent(metadata),
        }),
      },
      body: { completionMetadata: { ...body.completionMetadata, technologies: [] } },
    });
  }
}
