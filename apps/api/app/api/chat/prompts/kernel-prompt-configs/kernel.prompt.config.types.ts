/**
 * File layout modes for different CAD kernels:
 * - 'full-nesting': Can import any file from subdirectories (OpenSCAD, Replicad, JSCAD)
 * - 'assembly-only': Subdirectory imports must reference main.kcl entry points (Zoo/KCL)
 */
export type FileLayoutMode = 'full-nesting' | 'assembly-only';

/**
 * Configuration for a CAD kernel's system prompt.
 * Optimized per context-engineering.mdc: minimal fields, canonical example demonstrates behavior.
 */
export type KernelConfig = {
  /** File extension for this kernel (e.g., '.scad', '.ts', '.kcl', '.js') */
  fileExtension: string;

  /** Human-readable name for the kernel (e.g., 'OpenSCAD', 'Replicad') */
  languageName: string;

  /** Code output requirements - format constraints only, no examples (example demonstrates) */
  codeStandards: string;

  /** Common error patterns - terse, one-line descriptions */
  commonErrorPatterns: string;

  /** How this kernel handles file organization */
  fileLayoutMode: FileLayoutMode;

  /** Comprehensive canonical example demonstrating the full API surface */
  canonicalExample: string;

  /**
   * Single-line snippet demonstrating the minimal top-level construct that
   * makes a file render standalone (e.g. a default `main` export, an OpenSCAD
   * top-level invocation, a KCL `extrude` pipeline). Consumed by the
   * `test_model` tool description, its `FILE_NOT_FOUND`/`NO_TOP_LEVEL_GEOMETRY`
   * error messages, and the `<test_requirements>` system-prompt block.
   *
   * Snippets must carry the kernel's return-type vocabulary inline (e.g.
   * `: Shape3D`, `: Manifold`) so the agent receives the type contract from
   * the example alone, without a parallel prose noun phrase.
   */
  topLevelExportExample: string;

  /**
   * Optional multi-shape companion example. Used by kernels whose `main()` may
   * return an array of named/coloured parts (e.g. Replicad's `ShapeConfig[]`)
   * to teach the LLM that touching parts cluster into a single
   * `connectedComponents` group at the default tolerance, while per-geometry-unit
   * `watertight` remains the canonical "did the boolean fuse weld" guardrail.
   *
   * Wired into a `<multi_shape_pattern>` section in the system prompt only when
   * the field is non-empty; kernels without a multi-shape return type leave it
   * undefined and the section is omitted entirely.
   */
  multiShapeExample?: string;
};
