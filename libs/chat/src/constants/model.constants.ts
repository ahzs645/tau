/**
 * AI model providers.
 * @public
 */
export const modelProviders = [
  //
  'sambanova',
  'openai',
  'anthropic',
  'ollama',
  'vertexai',
  'cerebras',
] as const;

/**
 * AI model families.
 * @public
 */
export const modelFamilies = [
  //
  'gpt',
  'claude',
  'gemini',
] as const;
