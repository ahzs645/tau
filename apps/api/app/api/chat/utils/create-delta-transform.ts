import type { UIMessageChunk } from 'ai';

type DeltaChunk = UIMessageChunk & {
  type: 'text-delta' | 'reasoning-delta';
  delta: string;
};

type DeltaTransformer = (delta: string) => string;

function isDeltaChunk(chunk: UIMessageChunk): chunk is DeltaChunk {
  return (
    (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
    'delta' in chunk &&
    typeof chunk.delta === 'string'
  );
}

/**
 * Creates a TransformStream that rewrites only text-bearing delta chunks.
 *
 * `text-delta` and `reasoning-delta` chunks are transformed; all other chunk
 * types pass through unchanged.
 */
export function createDeltaTransform(transform: DeltaTransformer): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (!isDeltaChunk(chunk)) {
        controller.enqueue(chunk);
        return;
      }

      const transformed = transform(chunk.delta);
      if (transformed === chunk.delta) {
        controller.enqueue(chunk);
        return;
      }

      controller.enqueue({
        ...chunk,
        delta: transformed,
      });
    },
  });
}
