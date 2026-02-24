// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ensuring package consumers have access to the types
/// <reference path="./types/assimpjs.d.ts" />
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ensuring package consumers have access to the types
/// <reference path="./types/occt-import-js.d.ts" />

// Main conversion functions
export { convertFile, importToGlb, exportFromGlb } from '#conversion.js';

// Format validation and utility functions
export {
  getSupportedInputFormats,
  getSupportedOutputFormats,
  isInputFormatSupported,
  isOutputFormatSupported,
} from '#conversion.js';

// Direct access to import and export pipelines
export { importFiles, supportedImportFormats } from '#import.js';
export { exportFiles, supportedExportFormats } from '#export.js';

// Format metadata (re-exported from @taucad/types)
export { formatConfigurations } from '@taucad/types/constants';

// Types
export type { SupportedImportFormat } from '#import.js';
export type { SupportedExportFormat } from '#export.js';
