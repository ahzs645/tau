import type { Port } from '#port.js';
import type { Channel, ChannelServer } from '#channel.js';
import { createChannelClient, createChannelServer } from '#channel.js';

const muxVersion = 1;

/**
 * Single-payload mux frame (no chunking).
 */
type MuxFrameSingle = {
  readonly v: typeof muxVersion;
  readonly t: 's';
  readonly sid: string;
  readonly inner: unknown;
};

/**
 * Chunked mux frame: one logical message split into JSON string fragments. `i` runs `0..tot-1`.
 */
type MuxFrameChunk = {
  readonly v: typeof muxVersion;
  readonly t: 'k';
  readonly sid: string;
  readonly m: string;
  readonly i: number;
  readonly tot: number;
  readonly c: string;
};

/**
 * Wire frames produced by {@link multiplex}.
 *
 * @public
 */
export type MuxMessage = MuxFrameSingle | MuxFrameChunk;

/**
 * Tuning options for {@link multiplex}.
 *
 * @public
 */
export type MultiplexOptions = {
  /**
   * When `JSON.stringify(inner)` exceeds this (UTF-16 code units), the inner is chunked into
   * fragments of at most this length and reassembled at the receiver. Defaults to `8128`.
   */
  maxSingleStringLength?: number;
};

/**
 * Many logical {@link Channel} sessions multiplexed over a single {@link Port}.
 *
 * @public
 */
export type MultiplexedPort = {
  open(sessionId: string): Channel;
  serve(sessionId: string, impl: ChannelServer): { dispose: () => void };
  close(): void;
};

type ChunkBuffer = {
  parts: Array<string | undefined>;
  tot: number;
  filled: number;
};

const isMuxMessage = (value: unknown): value is MuxMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const o = value as { v?: unknown; t?: unknown };
  return o.v === muxVersion && (o.t === 's' || o.t === 'k');
};

const safeJsonString = (value: unknown): string => JSON.stringify(value);

const safeJsonParse = (s: string): unknown => JSON.parse(s) as unknown;

/**
 * Walk a structured-clone payload looking for `ArrayBuffer`, `SharedArrayBuffer`, or any
 * `ArrayBufferView` (e.g., `Uint8Array`). Used to gate the JSON chunker — binary payloads
 * are passed through structured-clone natively rather than stringified into oblivion.
 *
 * The walk is non-cyclic-safe by design (we trust callers not to feed cycles into RPC),
 * and bails early at the first match for O(first-binary-leaf) behaviour.
 */
const containsBinary = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (value instanceof ArrayBuffer) {
    return true;
  }
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    return true;
  }
  if (ArrayBuffer.isView(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsBinary(item)) {
        return true;
      }
    }
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (containsBinary(v)) {
      return true;
    }
  }
  return false;
};

/**
 * Multiplex many logical {@link Channel} sessions over a single {@link Port}. Adds per-session
 * demux, optional chunking of large `inner` JSON, and a {@link MultiplexedPort.close} to detach.
 *
 * @param root - Physical postMessage port (e.g. one side of a `MessageChannel`)
 * @param options - Tuning; chunking triggers when the serialized inner exceeds `maxSingleStringLength`
 * @returns A {@link MultiplexedPort} that opens client/server channels per session id
 * @public
 */
export const multiplex: (root: Port<unknown>, options?: MultiplexOptions) => MultiplexedPort = (root, options) => {
  const maxSingleStringLength = options?.maxSingleStringLength ?? 8128;

  const chunkBuffers = new Map<string, Map<string, ChunkBuffer>>();
  const handlers = new Map<string, Set<(d: unknown) => void>>();

  const getHandlerSet = (sessionId: string): Set<(d: unknown) => void> => {
    let s = handlers.get(sessionId);
    if (!s) {
      s = new Set();
      handlers.set(sessionId, s);
    }
    return s;
  };

  const dispatchInner = (sessionId: string, inner: unknown): void => {
    const set = handlers.get(sessionId);
    if (!set) {
      return;
    }
    for (const h of set) {
      h(inner);
    }
  };

  const onRoot = (raw: unknown): void => {
    if (!isMuxMessage(raw)) {
      return;
    }
    if (raw.t === 's') {
      dispatchInner(raw.sid, raw.inner);
      return;
    }
    const byMessage = chunkBuffers.get(raw.sid) ?? new Map<string, ChunkBuffer>();
    chunkBuffers.set(raw.sid, byMessage);
    let buf = byMessage.get(raw.m);
    if (!buf) {
      buf = { parts: Array.from<string | undefined>({ length: raw.tot }), tot: raw.tot, filled: 0 };
      byMessage.set(raw.m, buf);
    }
    if (buf.parts[raw.i] === undefined) {
      buf.parts[raw.i] = raw.c;
      buf.filled += 1;
    }
    if (buf.filled < buf.tot) {
      return;
    }
    byMessage.delete(raw.m);
    if (byMessage.size === 0) {
      chunkBuffers.delete(raw.sid);
    }
    const joined = buf.parts.join('');
    dispatchInner(raw.sid, safeJsonParse(joined));
  };

  const offRoot = root.onMessage(onRoot);
  if (root.start) {
    root.start();
  }

  const postInner = (sessionId: string, inner: unknown, transfer: readonly Transferable[] | undefined): void => {
    const transferList = transfer && transfer.length > 0 ? transfer : undefined;
    // Binary payloads (transferables present, or inner contains ArrayBuffer/TypedArray)
    // are sent as a single structured-clone frame — never JSON-chunked. JSON chunking
    // would either explode `Uint8Array` into `{"0":1,…}` form or strip transferables.
    const skipChunking = transferList !== undefined || containsBinary(inner);
    if (skipChunking) {
      const frame: MuxFrameSingle = { v: muxVersion, t: 's', sid: sessionId, inner };
      root.postMessage(frame, transferList);
      return;
    }
    const s = safeJsonString(inner);
    if (s.length <= maxSingleStringLength) {
      const frame: MuxFrameSingle = { v: muxVersion, t: 's', sid: sessionId, inner };
      root.postMessage(frame);
      return;
    }
    const chunkSize = maxSingleStringLength;
    const chunks: string[] = [];
    for (let p = 0; p < s.length; p += chunkSize) {
      chunks.push(s.slice(p, p + chunkSize));
    }
    const m = `m${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tot = chunks.length;
    for (let i = 0; i < tot; i += 1) {
      const frame: MuxFrameChunk = {
        v: muxVersion,
        t: 'k',
        sid: sessionId,
        m,
        i,
        tot,
        c: chunks[i]!,
      };
      root.postMessage(frame);
    }
  };

  const createSessionPort = (sessionId: string): Port<unknown> => ({
    capabilities: root.capabilities,
    postMessage: (data: unknown, transfer?: readonly Transferable[]) => {
      postInner(sessionId, data, transfer);
    },
    onMessage: (handler) => {
      const set = getHandlerSet(sessionId);
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) {
          handlers.delete(sessionId);
        }
      };
    },
    close: () => {
      handlers.delete(sessionId);
      chunkBuffers.delete(sessionId);
    },
  });

  let closed = false;

  return {
    open: (sessionId: string) => {
      if (closed) {
        throw new Error('MultiplexedPort is closed');
      }
      const sessionPort = createSessionPort(sessionId);
      return createChannelClient({ port: sessionPort, sessionKey: sessionId });
    },
    serve: (sessionId: string, impl: ChannelServer) => {
      if (closed) {
        throw new Error('MultiplexedPort is closed');
      }
      const sessionPort = createSessionPort(sessionId);
      return createChannelServer({ port: sessionPort, sessionKey: sessionId, impl });
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      offRoot();
      chunkBuffers.clear();
      handlers.clear();
    },
  };
};
