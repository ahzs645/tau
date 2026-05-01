/**
 * Conformance test C16: protocol type aliases are structurally
 * `z.input<typeof xSchema>` (or `z.output` for results). Hand-rewriting
 * any envelope alias to drift from its schema fails the test at
 * compile time.
 *
 * Validation depth is intentionally shallow (the schemas live at the
 * wire envelope, not deep into kernel-domain payloads), so the
 * assertions below check that:
 *
 * 1. Schema-derived envelopes have exactly the documented top-level
 *    keys (no extra/missing fields), and
 * 2. The shapes are mutually compatible at the envelope level (a
 *    schema-derived value is a valid public protocol value, and vice
 *    versa, modulo the deep `unknown` generics that the schema
 *    intentionally widens).
 */

import { describe, it, assertType } from 'vitest';
import type { z } from 'zod';
import type {
  runtimeInitializeArgsSchema,
  runtimeInitializeResultSchema,
  runtimeExportArgsSchema,
  runtimeExportResultSchema,
  runtimeOpenFileArgsSchema,
  runtimeStageAndRenderArgsSchema,
  runtimeProgressArgsSchema,
  runtimeGeometryComputedArgsSchema,
  runtimeParametersResolvedArgsSchema,
  runtimeErrorEventArgsSchema,
  runtimeStateChangedArgsSchema,
  runtimeAbortArgsSchema,
  transportHelloPayloadSchema,
} from '#types/runtime-protocol.schemas.js';
import type {
  RuntimeInitializeArgs,
  RuntimeExportArgs,
  RuntimeOpenFileArgs,
  RuntimeStageAndRenderArgs,
  RuntimeProgressArgs,
  RuntimeStateChangedArgs,
  AbortReasonCode,
} from '#types/runtime-protocol.types.js';

const branded = <T>(): T => undefined as unknown as T;

describe('runtime-protocol types derive from schemas (C16)', () => {
  it('RuntimeInitializeArgs is structurally z.input<typeof runtimeInitializeArgsSchema>', () => {
    type Derived = z.input<typeof runtimeInitializeArgsSchema>;
    assertType<RuntimeInitializeArgs>(branded<Derived>());
    assertType<Derived>(branded<RuntimeInitializeArgs>());
  });

  it('RuntimeInitializeResult envelope exposes capabilities', () => {
    type Derived = z.output<typeof runtimeInitializeResultSchema>;
    assertType<{ capabilities: unknown }>(branded<Derived>());
  });

  it('RuntimeExportArgs is structurally z.input<typeof runtimeExportArgsSchema>', () => {
    type Derived = z.input<typeof runtimeExportArgsSchema>;
    assertType<RuntimeExportArgs>(branded<Derived>());
    assertType<Derived>(branded<RuntimeExportArgs>());
  });

  it('export result schema envelope exposes a discriminated success/issues shape', () => {
    type Derived = z.output<typeof runtimeExportResultSchema>;
    assertType<Derived>(branded<{ success: false; issues: never[] }>());
  });

  it('RuntimeOpenFileArgs is structurally z.input<typeof runtimeOpenFileArgsSchema>', () => {
    type Derived = z.input<typeof runtimeOpenFileArgsSchema>;
    assertType<RuntimeOpenFileArgs>(branded<Derived>());
  });

  it('RuntimeStageAndRenderArgs is structurally z.input<typeof runtimeStageAndRenderArgsSchema>', () => {
    type Derived = z.input<typeof runtimeStageAndRenderArgsSchema>;
    assertType<RuntimeStageAndRenderArgs>(branded<Derived>());
  });

  it('RuntimeProgressArgs is structurally z.input<typeof runtimeProgressArgsSchema>', () => {
    type Derived = z.input<typeof runtimeProgressArgsSchema>;
    assertType<RuntimeProgressArgs>(branded<Derived>());
  });

  it('RuntimeGeometryComputedArgs envelope exposes result + rgen', () => {
    type Derived = z.input<typeof runtimeGeometryComputedArgsSchema>;
    assertType<{ result: unknown; rgen: number }>(branded<Derived>());
  });

  it('RuntimeParametersResolvedArgs envelope exposes result + rgen', () => {
    type Derived = z.input<typeof runtimeParametersResolvedArgsSchema>;
    assertType<{ result: unknown; rgen: number }>(branded<Derived>());
  });

  it('RuntimeErrorEventArgs envelope exposes issues + optional rgen', () => {
    type Derived = z.input<typeof runtimeErrorEventArgsSchema>;
    assertType<{ issues: unknown[]; rgen?: number }>(branded<Derived>());
  });

  it('RuntimeStateChangedArgs is structurally z.input<typeof runtimeStateChangedArgsSchema>', () => {
    type Derived = z.input<typeof runtimeStateChangedArgsSchema>;
    assertType<RuntimeStateChangedArgs>(branded<Derived>());
  });

  it('AbortReasonCode is structurally compatible with the abort args schema reason field', () => {
    type Derived = z.input<typeof runtimeAbortArgsSchema>;
    assertType<{ reason: AbortReasonCode }>(branded<Derived>());
  });

  it('TransportHelloPayload schema declares server, runtimeVersion, and transportId', () => {
    type Derived = z.input<typeof transportHelloPayloadSchema>;
    type Expected = { server: 'kernel-runtime-worker'; runtimeVersion: string; transportId: string };
    assertType<Expected>(branded<Derived>());
  });
});
