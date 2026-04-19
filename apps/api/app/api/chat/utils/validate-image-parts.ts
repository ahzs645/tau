import type { MyUIMessage } from '@taucad/chat';

/**
 * Maximum base64 string length for image data URLs (~5 MB raw).
 * Matches Anthropic's API limit.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Domain constant
const MAX_BASE64_LENGTH = 5 * 1024 * 1024;

/**
 * Validates that all image file parts across messages do not exceed
 * the 5 MB base64 size limit. Throws a descriptive error if any do.
 *
 * Should be called in prepareMessages before conversion to LangChain format.
 *
 * @public
 */
export function validateImageParts(messages: MyUIMessage[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.parts)) {
      continue;
    }

    for (const part of message.parts) {
      if (
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'file' &&
        'mediaType' in part &&
        typeof part.mediaType === 'string' &&
        part.mediaType.startsWith('image/') &&
        'url' in part &&
        typeof part.url === 'string'
      ) {
        const dataPrefix = 'base64,';
        const base64Start = part.url.indexOf(dataPrefix);
        if (base64Start === -1) {
          continue;
        }

        const base64Data = part.url.slice(base64Start + dataPrefix.length);
        if (base64Data.length > MAX_BASE64_LENGTH) {
          const sizeMb = (base64Data.length / (1024 * 1024)).toFixed(1);
          throw new Error(`Image exceeds 5 MB base64 limit (${sizeMb} MB). Please resize the image before uploading.`);
        }
      }
    }
  }
}
