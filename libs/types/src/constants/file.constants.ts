/**
 * MIME type for file drags originating from the headless-tree file explorer.
 * Used by Dockview drop handlers to identify internal file drag-and-drop.
 */
export const tauFileDragMime = 'application/x-tau-file';

/**
 * The export formats.
 */
export const exportFormats = [
  //
  'stl',
  'stl-binary',
  'step',
  'step-assembly',
  'glb',
  'gltf',
  '3mf',
] as const satisfies string[];

/**
 * Map of export formats to file extensions
 */
export const fileExtensionFromExportFormat = {
  stl: 'stl',
  'stl-binary': 'stl',
  step: 'step',
  'step-assembly': 'step',
  glb: 'glb',
  gltf: 'gltf',
  // eslint-disable-next-line @typescript-eslint/naming-convention -- File format names don't follow camelCase
  '3mf': '3mf',
} as const satisfies Record<(typeof exportFormats)[number], string>;
