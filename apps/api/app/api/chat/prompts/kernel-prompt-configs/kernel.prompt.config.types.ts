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
};
