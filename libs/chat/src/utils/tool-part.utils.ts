import type { MyMessagePart, MyToolPart } from '#types/message.types.js';

/**
 * Type guard that narrows a MyMessagePart to MyToolPart (any static tool-* part).
 * @public
 */
export function isToolPart(part: MyMessagePart): part is MyToolPart {
  return part.type.startsWith('tool-');
}
