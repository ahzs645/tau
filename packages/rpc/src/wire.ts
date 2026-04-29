/**
 * Internal wire codec between {@link createChannelClient} and {@link createChannelServer}.
 *
 * Versioned with `v` for forward compatibility; uses 2-character family-prefixed kind
 * codes for legibility (`r*` RPC, `n*` notify, `s*` stream, `l*` lifecycle, `f*` flow).
 *
 * The full normative specification lives in {@link ../../../docs/architecture/rpc-wire-spec.md},
 * with prior art mapped to LSP, VS Code's `rpcProtocol.ts`, and `kkrpc`.
 */
export const wireVersion = 1;

/**
 * Structured error payload. `m` is mandatory and human-readable; `c` is an optional
 * machine-readable code; `s` is an optional stack (typically dev-only).
 *
 * @public
 */
export type WireError = {
  readonly m: string;
  readonly c?: string | number;
  readonly s?: string;
};

/* ============================================================================ *
 * RPC family (`r*`)                                                            *
 * ============================================================================ */

/** Client → server: invoke a one-shot call by name. */
export type WireRequest = {
  readonly v: 1;
  readonly k: 'rq';
  readonly i: string;
  readonly n: string;
  readonly a: unknown;
};

/** Server → client: successful reply for a {@link WireRequest}. */
export type WireResponseOk = {
  readonly v: 1;
  readonly k: 'rs';
  readonly i: string;
  readonly o: 1;
  readonly d: unknown;
};

/** Server → client: error reply for a {@link WireRequest}. */
export type WireResponseError = {
  readonly v: 1;
  readonly k: 'rs';
  readonly i: string;
  readonly o: 0;
  readonly e: WireError;
};

/** Server → client: union of {@link WireResponseOk} and {@link WireResponseError}. */
export type WireResponse = WireResponseOk | WireResponseError;

/**
 * Client → server: cooperatively cancel a pending {@link WireRequest}.
 * Mirrors LSP `$/cancelRequest`. Server piping the request observes `signal.aborted`.
 */
export type WireRequestCancel = {
  readonly v: 1;
  readonly k: 'rc';
  readonly i: string;
  readonly e?: WireError;
};

/* ============================================================================ *
 * Notification family (`n*`)                                                   *
 * ============================================================================ */

/**
 * Bidirectional fire-and-forget notification. No correlation id, no reply.
 * Used for autonomous server events (e.g. `progress`, `geometry`) and client-to-server
 * commands without return values (e.g. `openFile`, `updateParameters`).
 */
export type WireNotify = {
  readonly v: 1;
  readonly k: 'nt';
  readonly n: string;
  readonly a: unknown;
};

/* ============================================================================ *
 * Stream family (`s*`)                                                         *
 * ============================================================================ */

/** Client → server: open a server-pushed stream. */
export type WireStreamSubscribe = {
  readonly v: 1;
  readonly k: 'ss';
  readonly i: string;
  readonly n: string;
  readonly a: unknown;
};

/** Server → client: stream chunk. */
export type WireStreamNext = {
  readonly v: 1;
  readonly k: 'sn';
  readonly i: string;
  readonly d: unknown;
};

/** Server → client: stream finished cleanly. */
export type WireStreamComplete = {
  readonly v: 1;
  readonly k: 'sc';
  readonly i: string;
};

/** Server → client: stream errored (terminal). */
export type WireStreamError = {
  readonly v: 1;
  readonly k: 'se';
  readonly i: string;
  readonly e: WireError;
};

/**
 * Client → server: consumer-initiated cancel of an active subscription.
 * Producer should stop emitting `sn` and respond with terminal `sc` once cleanup is done.
 */
export type WireStreamUnsubscribe = {
  readonly v: 1;
  readonly k: 'su';
  readonly i: string;
};

/* ============================================================================ *
 * Lifecycle family (`l*`)                                                      *
 * ============================================================================ */

/** Server → client: connection-established handshake (success). */
export type WireHelloOk = {
  readonly v: 1;
  readonly k: 'lh';
  readonly o: 1;
  readonly d?: unknown;
};

/** Server → client: connection-established handshake (failure). */
export type WireHelloError = {
  readonly v: 1;
  readonly k: 'lh';
  readonly o: 0;
  readonly e: WireError;
};

/** Server → client: union of {@link WireHelloOk} and {@link WireHelloError}. */
export type WireHello = WireHelloOk | WireHelloError;

/** Bidirectional graceful close control. After `lb`, no further frames are accepted. */
export type WireBye = {
  readonly v: 1;
  readonly k: 'lb';
  readonly r?: string;
};

/* ============================================================================ *
 * Flow control family (`f*`) — RESERVED for a future revision                  *
 * ============================================================================ */

/**
 * Reserved: acknowledge frames up to id `i`. Not implemented; receivers log once
 * and drop. Reserving the kind code prevents wire-format break when flow control
 * lands.
 */
export type WireFlowAck = {
  readonly v: 1;
  readonly k: 'fa';
  readonly i: string;
};

/**
 * Reserved: grant `s` more stream-frame slots for stream id `i`. Not implemented;
 * receivers log once and drop.
 */
export type WireFlowWindow = {
  readonly v: 1;
  readonly k: 'fw';
  readonly i: string;
  readonly s: number;
};

/* ============================================================================ *
 * Discriminated union                                                          *
 * ============================================================================ */

/** Discriminated union of all v1 wire envelopes. */
export type WireMessage =
  | WireRequest
  | WireResponse
  | WireRequestCancel
  | WireNotify
  | WireStreamSubscribe
  | WireStreamNext
  | WireStreamComplete
  | WireStreamError
  | WireStreamUnsubscribe
  | WireHello
  | WireBye
  | WireFlowAck
  | WireFlowWindow;

/** Set of known kind codes. Frames whose `k` is not in this set are dropped. */
const knownKinds: ReadonlySet<string> = new Set<string>([
  'rq',
  'rs',
  'rc',
  'nt',
  'ss',
  'sn',
  'sc',
  'se',
  'su',
  'lh',
  'lb',
  'fa',
  'fw',
]);

const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmptyString = (value: unknown): value is string => isString(value) && value.length > 0;
const isWireErrorShape = (value: unknown): value is WireError => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const o = value as { m?: unknown; c?: unknown; s?: unknown };
  if (!isString(o.m)) {
    return false;
  }
  if (o.c !== undefined && typeof o.c !== 'string' && typeof o.c !== 'number') {
    return false;
  }
  if (o.s !== undefined && !isString(o.s)) {
    return false;
  }
  return true;
};

/**
 * Type guard for {@link WireMessage}. Validates `v`, the kind code, and per-kind required
 * fields. Frames with `_`-prefixed kinds (transport-internal) and unknown kinds are rejected.
 *
 * @param value - Arbitrary inbound payload from a {@link Port}
 * @returns `true` when `value` matches a known v1 wire envelope shape
 */
type WireFrameLike = {
  v?: unknown;
  k?: unknown;
  i?: unknown;
  n?: unknown;
  a?: unknown;
  d?: unknown;
  o?: unknown;
  e?: unknown;
  r?: unknown;
  s?: unknown;
};

export const isWireMessage = (value: unknown): value is WireMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const o = value as WireFrameLike;
  if (o.v !== wireVersion) {
    return false;
  }
  if (!isString(o.k)) {
    return false;
  }
  if (o.k.startsWith('_')) {
    return false;
  }
  if (!knownKinds.has(o.k)) {
    return false;
  }
  switch (o.k) {
    case 'rq': {
      return isNonEmptyString(o.i) && isNonEmptyString(o.n) && 'a' in value;
    }
    case 'rs': {
      if (!isNonEmptyString(o.i)) {
        return false;
      }
      if (o.o === 1) {
        return 'd' in value;
      }
      if (o.o === 0) {
        return isWireErrorShape(o.e);
      }
      return false;
    }
    case 'rc': {
      return isNonEmptyString(o.i) && (o.e === undefined || isWireErrorShape(o.e));
    }
    case 'nt': {
      return isNonEmptyString(o.n) && 'a' in value;
    }
    case 'ss': {
      return isNonEmptyString(o.i) && isNonEmptyString(o.n) && 'a' in value;
    }
    case 'sn': {
      return isNonEmptyString(o.i) && 'd' in value;
    }
    case 'sc':
    case 'su': {
      return isNonEmptyString(o.i);
    }
    case 'se': {
      return isNonEmptyString(o.i) && isWireErrorShape(o.e);
    }
    case 'lh': {
      if (o.o === 1) {
        return true;
      }
      if (o.o === 0) {
        return isWireErrorShape(o.e);
      }
      return false;
    }
    case 'lb': {
      return o.r === undefined || isString(o.r);
    }
    case 'fa': {
      return isNonEmptyString(o.i);
    }
    case 'fw': {
      return isNonEmptyString(o.i) && typeof o.s === 'number' && Number.isFinite(o.s);
    }
    default: {
      return false;
    }
  }
};
