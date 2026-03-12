/* eslint-disable @typescript-eslint/naming-convention -- file format names don't follow camelCase */
/**
 * Canonical MIME types for 3D file formats.
 * Single source of truth consumed by @taucad/runtime, @taucad/converter, and apps.
 * Keyed by file extension so any package can look up MIME types without
 * depending on a specific format union type.
 */
export const mimeTypes = {
  // GlTF
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',

  // CAD interchange
  step: 'application/step',
  stp: 'application/step',
  iges: 'application/iges',
  igs: 'application/iges',
  brep: 'application/octet-stream',

  // Mesh
  stl: 'model/stl',
  obj: 'model/obj', // eslint-disable-line id-denylist -- OBJ file format identifier
  ply: 'application/x-ply',
  off: 'application/x-off',
  '3mf': 'model/3mf',

  // Animation / legacy
  fbx: 'application/octet-stream',
  dae: 'model/vnd.collada+xml',
  '3ds': 'application/x-3ds',
  x: 'application/x-directx',
  x3d: 'model/x3d+xml',
  x3db: 'model/x3d+fastinfoset',
  x3dv: 'model/x3d-vrml',

  // USD
  usda: 'model/vnd.usda',
  usdc: 'model/vnd.usd',
  usdz: 'model/vnd.usdz+zip',

  // Other
  '3dm': 'application/x-3dm',
  ac: 'application/x-ac3d',
  amf: 'application/x-amf',
  ase: 'application/x-ase',
  bvh: 'application/x-bvh',
  cob: 'application/x-cob',
  drc: 'application/octet-stream',
  dxf: 'application/dxf',
  ifc: 'application/x-step',
  lwo: 'application/x-lightwave',
  md2: 'application/x-md2',
  md5mesh: 'application/x-md5mesh',
  'mesh.xml': 'application/x-ogre-mesh+xml',
  nff: 'application/x-nff',
  ogex: 'application/x-ogex',
  smd: 'application/x-smd',
  wrl: 'model/vrml',
  xgl: 'application/x-xgl',
} as const satisfies Record<string, string>;

/**
 * Look up a MIME type by file extension.
 * Returns `'application/octet-stream'` for unknown extensions.
 */
export function lookupMimeType(extension: string): (typeof mimeTypes)[keyof typeof mimeTypes] {
  if (extension in mimeTypes) {
    return mimeTypes[extension as keyof typeof mimeTypes];
  }

  return 'application/octet-stream';
}
