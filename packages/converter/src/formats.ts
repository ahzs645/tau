/**
 * Lightweight format metadata — format key arrays and types without loader/exporter dependencies.
 *
 * Import from `@taucad/converter/formats` when only format lists or types are needed,
 * avoiding the heavyweight loader/exporter evaluation chain.
 *
 * @public
 */

/* eslint-disable @typescript-eslint/naming-convention -- formats can be valid identifiers */

const importFormatKeys = [
  '3dm',
  '3ds',
  '3mf',
  'ac',
  'ase',
  'amf',
  'brep',
  'bvh',
  'cob',
  'dae',
  'drc',
  'dxf',
  'fbx',
  'glb',
  'gltf',
  'ifc',
  'iges',
  'igs',
  'lwo',
  'md2',
  'md5mesh',
  'mesh.xml',
  'nff',
  'obj',
  'off',
  'ogex',
  'ply',
  'step',
  'stl',
  'stp',
  'smd',
  'usda',
  'usdz',
  'wrl',
  'x',
  'x3d',
  'x3db',
  'x3dv',
  'xgl',
] as const;

const exportFormatKeys = [
  '3ds',
  'dae',
  'fbx',
  'glb',
  'gltf',
  'obj',
  'ply',
  'stl',
  'step',
  'usda',
  'usdz',
  'x',
  'x3d',
] as const;

/**
 * File extension recognized by the converter's import pipeline.
 *
 * @public
 */
export type SupportedImportFormat = (typeof importFormatKeys)[number];

/**
 * File extension recognized by the converter's export pipeline.
 *
 * @public
 */
export type SupportedExportFormat = (typeof exportFormatKeys)[number];

/**
 * All file extensions supported by the import pipeline.
 *
 * @public
 */
export const supportedImportFormats: readonly SupportedImportFormat[] = importFormatKeys;

/**
 * All file extensions supported by the export pipeline.
 *
 * @public
 */
export const supportedExportFormats: readonly SupportedExportFormat[] = exportFormatKeys;
