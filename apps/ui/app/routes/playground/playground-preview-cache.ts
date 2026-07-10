import type { Geometry } from '@taucad/types';
import { LruMap } from '@taucad/utils/cache';

const mebibyte = 1024 * 1024;

export const defaultPlaygroundPreviewCacheOptions = {
  maxBytes: 64 * mebibyte,
  maxEntries: 8,
} as const;

export type PlaygroundPreviewCacheRequest = {
  readonly activeRenderIdentity: string;
  readonly mainFile: string;
  readonly parameters: Record<string, unknown>;
  readonly renderOptions: Record<string, unknown> | undefined;
  readonly sourceFiles: Readonly<Record<string, string>>;
};

/** Stable tagged serialization for render-request cache keys and parameter comparisons. */
export function serializePlaygroundCacheValue(value: unknown, seen = new Set<unknown>()): string {
  switch (typeof value) {
    case 'undefined': {
      return 'undefined';
    }
    case 'boolean': {
      return `boolean:${value}`;
    }
    case 'number': {
      if (Number.isNaN(value)) {
        return 'number:NaN';
      }
      if (value === Number.POSITIVE_INFINITY) {
        return 'number:Infinity';
      }
      if (value === Number.NEGATIVE_INFINITY) {
        return 'number:-Infinity';
      }
      if (Object.is(value, -0)) {
        return 'number:-0';
      }
      return `number:${value}`;
    }
    case 'bigint': {
      return `bigint:${value}`;
    }
    case 'string': {
      return `string:${JSON.stringify(value)}`;
    }
    case 'function':
    case 'symbol': {
      throw new TypeError(`Unsupported cache-key value: ${typeof value}`);
    }
    case 'object': {
      if (value === null) {
        return 'null';
      }
      if (seen.has(value)) {
        throw new TypeError('Cannot serialize a cyclic cache-key value');
      }

      seen.add(value);
      try {
        if (value instanceof Date) {
          return `date:${value.toISOString()}`;
        }
        if (value instanceof Uint8Array) {
          return `bytes:${[...value].join(',')}`;
        }
        if (Array.isArray(value)) {
          return `array:[${value.map((item) => serializePlaygroundCacheValue(item, seen)).join(',')}]`;
        }

        const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
          left.localeCompare(right),
        );
        return `object:{${entries
          .map(
            ([key, item]) => `${serializePlaygroundCacheValue(key, seen)}:${serializePlaygroundCacheValue(item, seen)}`,
          )
          .join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
  }
}

/** Build a dependency-complete key for one playground preview request. */
export function buildPlaygroundPreviewCacheKey(request: PlaygroundPreviewCacheRequest): string {
  return serializePlaygroundCacheValue(request);
}

/** Compare parameter records without depending on object key order. */
export function haveSamePlaygroundParameters(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return serializePlaygroundCacheValue(left) === serializePlaygroundCacheValue(right);
}

function cloneCacheableGeometry(geometry: Geometry): Geometry | undefined {
  switch (geometry.format) {
    case 'gltf': {
      return { ...geometry, content: new Uint8Array(geometry.content) };
    }
    case 'svg': {
      return { ...geometry, paths: [...geometry.paths] };
    }
    case 'webrtc': {
      return undefined;
    }
  }
}

function cloneCacheableGeometries(geometries: readonly Geometry[]): readonly Geometry[] | undefined {
  const cloned: Geometry[] = [];
  for (const geometry of geometries) {
    const copy = cloneCacheableGeometry(geometry);
    if (!copy) {
      return undefined;
    }
    cloned.push(copy);
  }
  return cloned.length > 0 ? cloned : undefined;
}

function geometryByteLength(geometries: readonly Geometry[]): number {
  let total = 0;
  for (const geometry of geometries) {
    switch (geometry.format) {
      case 'gltf': {
        total += geometry.content.byteLength;
        break;
      }
      case 'svg': {
        for (const path of geometry.paths) {
          total += path.length * 2;
        }
        break;
      }
      case 'webrtc': {
        break;
      }
    }
  }
  return total;
}

/** Create a byte- and entry-bounded LRU for immutable playground geometry snapshots. */
export function createPlaygroundPreviewCache(
  options: { readonly maxBytes: number; readonly maxEntries: number } = defaultPlaygroundPreviewCacheOptions,
): LruMap<readonly Geometry[]> {
  return new LruMap({
    maxEntries: options.maxEntries,
    maxWeight: options.maxBytes,
    getWeight: geometryByteLength,
  });
}

/** Copy a completed geometry snapshot into the cache's ownership boundary. */
export function cachePlaygroundPreviewGeometries(
  cache: LruMap<readonly Geometry[]>,
  cacheKey: string,
  geometries: readonly Geometry[],
): boolean {
  const cloned = cloneCacheableGeometries(geometries);
  return cloned ? cache.set(cacheKey, cloned) : false;
}
