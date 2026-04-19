import type { UIMessageChunk } from 'ai';

/**
 * Per-block state for the newline trimming transform.
 * Each text/reasoning block (identified by chunk `id`) gets independent state.
 */
type BlockState = {
  hasContent: boolean;
  pendingNewlines: string;
};

/**
 * Chunk types that carry a `delta` string to trim.
 */
type DeltaChunk = UIMessageChunk & {
  type: 'text-delta' | 'reasoning-delta';
  id: string;
  delta: string;
};

function isDeltaChunk(chunk: UIMessageChunk): chunk is DeltaChunk {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta';
}

function isBlockStart(chunk: UIMessageChunk): chunk is UIMessageChunk & { id: string } {
  return chunk.type === 'text-start' || chunk.type === 'reasoning-start';
}

function isBlockEnd(chunk: UIMessageChunk): chunk is UIMessageChunk & { id: string } {
  return chunk.type === 'text-end' || chunk.type === 'reasoning-end';
}

/**
 * Processes a streaming delta through the block's newline state.
 *
 * Handles three concerns:
 * 1. Leading newlines — suppressed until first real content
 * 2. Interior runs of 3+ newlines — collapsed to `\n\n`
 * 3. Trailing newlines — buffered and discarded on block end
 *
 * @returns The trimmed delta string, or `undefined` if the chunk should be suppressed
 */
function processDelta(delta: string, state: BlockState): string | undefined {
  const combined = state.pendingNewlines + delta;
  state.pendingNewlines = '';

  let processed = combined;

  if (!state.hasContent) {
    processed = processed.replace(/^\n+/, '');
  }

  processed = processed.replaceAll(/\n{3,}/g, '\n\n');

  const trailingMatch = /\n+$/.exec(processed);
  if (trailingMatch) {
    state.pendingNewlines = trailingMatch[0];
    processed = processed.slice(0, -state.pendingNewlines.length);
  }

  if (processed.length > 0) {
    state.hasContent = true;
    return processed;
  }

  return undefined;
}

/**
 * Creates a TransformStream that trims excessive newlines from streaming
 * `text-delta` and `reasoning-delta` chunks.
 *
 * State is tracked per block ID so concurrent text and reasoning blocks
 * are trimmed independently. The transform:
 * - Strips leading newlines at the start of each block
 * - Collapses interior runs of 3+ newlines to `\n\n`
 * - Discards trailing newlines when the block ends
 *
 * All non-delta chunk types pass through unchanged.
 *
 * @returns A TransformStream that processes UIMessageChunk events
 */
export function createNewlineTrimTransform(): TransformStream<UIMessageChunk, UIMessageChunk> {
  const blocks = new Map<string, BlockState>();

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (isBlockStart(chunk)) {
        blocks.set(chunk.id, { hasContent: false, pendingNewlines: '' });
        controller.enqueue(chunk);
        return;
      }

      if (isBlockEnd(chunk)) {
        blocks.delete(chunk.id);
        controller.enqueue(chunk);
        return;
      }

      if (isDeltaChunk(chunk)) {
        const { type, id, delta } = chunk;
        const state = blocks.get(id);
        if (!state) {
          controller.enqueue(chunk);
          return;
        }

        const trimmed = processDelta(delta, state);
        if (trimmed !== undefined) {
          controller.enqueue({ type, id, delta: trimmed } as UIMessageChunk);
        }

        return;
      }

      controller.enqueue(chunk);
    },
  });
}
