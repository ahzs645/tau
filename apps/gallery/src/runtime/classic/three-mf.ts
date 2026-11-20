import { formatShapeName } from '@taucad/geometry-core';
import { strToU8, zipSync } from 'fflate';
import type { ClassicMesh } from '#runtime/classic/mesh.js';
import { closedNativeTopology, splitClassicBodies } from '#runtime/classic/topology.js';

type Point = ClassicMesh['vertices'][number];
type Triangle = ClassicMesh['triangles'][number];

const indexLimit = 2_147_483_648;
const materialResourceId = 1;
const firstObjectId = 2;
const colorMaximum = 255;
const coreNamespace = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const modelRelationship = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const modelContentType = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
const modelPart = '3D/3dmodel.model';
const coordinateText = (value: number): string => (Object.is(value, -0) ? '-0' : String(value));

const pointAt = (mesh: ClassicMesh, index: number): Point => {
  const point = mesh.vertices[index];
  if (!Number.isSafeInteger(index) || index < 0 || !point) {
    throw new RangeError(`Cannot export 3MF: invalid native vertex index ${index}.`);
  }
  return point;
};

const subtract = (left: Point, right: Point): Point => [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
const cross = (left: Point, right: Point): Point => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];

const colorHex = (color: Triangle['color']): string => {
  const channels = color.map((channel) => {
    const byte = Math.round(channel * colorMaximum);
    // The pinned native OFF palette is byte RGBA. Refuse unrepresentable colors instead of quantizing them.
    if (!Number.isFinite(channel) || byte < 0 || byte > colorMaximum || byte / colorMaximum !== channel) {
      throw new RangeError('Cannot export 3MF: native face color is not an exact sRGB RGBA byte tuple.');
    }
    return byte.toString(16).padStart(2, '0').toUpperCase();
  });
  return `#${channels.join('')}`;
};

const validateMesh = (mesh: ClassicMesh): void => {
  if (mesh.vertices.length === 0 || mesh.triangles.length === 0) {
    throw new RangeError('Cannot export 3MF: the native mesh is empty.');
  }
  if (mesh.vertices.length >= indexLimit || mesh.triangles.length >= indexLimit) {
    throw new RangeError('Cannot export 3MF: the native mesh exceeds the format index limit.');
  }
  if (mesh.vertices.some((point) => point.some((coordinate) => !Number.isFinite(coordinate)))) {
    throw new RangeError('Cannot export 3MF: native vertex coordinates must be finite.');
  }
  const referenced = new Set<number>();
  for (const [faceIndex, triangle] of mesh.triangles.entries()) {
    const [a, b, c] = triangle.indices;
    const origin = pointAt(mesh, a);
    const normal = cross(subtract(pointAt(mesh, b), origin), subtract(pointAt(mesh, c), origin));
    const magnitude = Math.hypot(...normal);
    if (!Number.isFinite(magnitude) || magnitude === 0) {
      throw new RangeError(`Cannot export 3MF: native face ${faceIndex} has no finite nonzero area.`);
    }
    colorHex(triangle.color);
    referenced.add(a);
    referenced.add(b);
    referenced.add(c);
  }
  if (referenced.size !== mesh.vertices.length) {
    throw new RangeError('Cannot export 3MF: the native mesh has vertices with no surface owner.');
  }
};

const validateBody = (mesh: ClassicMesh, triangles: readonly Triangle[], name: string): void => {
  if (!closedNativeTopology(triangles.map(({ indices }) => indices))) {
    throw new RangeError(`Cannot export 3MF: ${name} is not a closed, consistently oriented native surface.`);
  }
  const first = triangles[0];
  if (!first) {
    throw new RangeError(`Cannot export 3MF: ${name} has no faces.`);
  }
  // Translate the volume calculation locally and compensate its sum; exported coordinates remain untouched.
  const reference = pointAt(mesh, first.indices[0]);
  let volume = 0;
  let correction = 0;
  for (const {
    indices: [a, b, c],
  } of triangles) {
    const left = subtract(pointAt(mesh, a), reference);
    const product = cross(subtract(pointAt(mesh, b), reference), subtract(pointAt(mesh, c), reference));
    const term = left[0] * product[0] + left[1] * product[1] + left[2] * product[2];
    const corrected = term - correction;
    const next = volume + corrected;
    correction = next - volume - corrected;
    volume = next;
  }
  if (!Number.isFinite(volume) || volume <= 0) {
    throw new RangeError(`Cannot export 3MF: ${name} must have finite positive native volume and outward winding.`);
  }
};

const bodyXml = ({
  mesh,
  triangles,
  ownerIndex,
  palette,
}: {
  mesh: ClassicMesh;
  triangles: readonly Triangle[];
  ownerIndex: number;
  palette: ReadonlyMap<string, number>;
}): string => {
  const name = formatShapeName(ownerIndex);
  validateBody(mesh, triangles, name);
  // A bijection from original IDs to the object's local index space preserves every vertex and face incidence.
  const nativeIds = [...new Set(triangles.flatMap(({ indices }) => indices))].sort((left, right) => left - right);
  const localIds = new Map(nativeIds.map((nativeId, index) => [nativeId, index]));
  const vertices = nativeIds.map((nativeId) => {
    const [x, y, z] = pointAt(mesh, nativeId);
    // ECMAScript's shortest decimal representation round-trips the original Float64 value; ST_Number permits exponents.
    return `<vertex x="${coordinateText(x)}" y="${coordinateText(y)}" z="${coordinateText(z)}"/>`;
  });
  const faces = triangles.map(({ indices, color }) => {
    const [a, b, c] = indices.map((index) => localIds.get(index));
    const material = palette.get(colorHex(color));
    if (a === undefined || b === undefined || c === undefined || material === undefined) {
      throw new Error('Cannot export 3MF: native face provenance is incomplete.');
    }
    return `<triangle v1="${a}" v2="${b}" v3="${c}" pid="${materialResourceId}" p1="${material}"/>`;
  });
  const first = triangles[0];
  const firstMaterial = first ? palette.get(colorHex(first.color)) : undefined;
  if (firstMaterial === undefined) {
    throw new Error('Cannot export 3MF: native owner has no material.');
  }
  return `<object id="${ownerIndex + firstObjectId}" name="${name}" type="model" pid="${materialResourceId}" pindex="${firstMaterial}"><mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object>`;
};

/**
 * Serialize the validated native surface directly as 3MF Core, without a Float32/GLB intermediary.
 * Preserve Z-up millimetres, exact native vertex identity, all faces, existing owners and byte sRGB RGBA.
 * Reject invalid surfaces; never weld, repair, delete faces, flip winding, or substitute an export after failure.
 * Core palette colors describe appearance, not a printer-specific material assignment.
 * @see https://github.com/3MFConsortium/spec_core/blob/997b385e06f3181cf9aae0c578e0b45ccd48ccb2/3MF%20Core%20Specification.md
 */
export const classicMeshToThreeMf = (mesh: ClassicMesh): Uint8Array<ArrayBuffer> => {
  validateMesh(mesh);
  const palette = new Map<string, number>();
  for (const { color } of mesh.triangles) {
    const hex = colorHex(color);
    if (!palette.has(hex)) {
      palette.set(hex, palette.size);
    }
  }
  const bodies = splitClassicBodies(mesh.vertices.length, mesh.triangles);
  if (bodies.length + firstObjectId > indexLimit || palette.size >= indexLimit) {
    throw new RangeError('Cannot export 3MF: the model exceeds the format resource limit.');
  }
  const objects = bodies.map((triangles, ownerIndex) => bodyXml({ mesh, triangles, ownerIndex, palette }));
  const materials = [...palette.keys()].map((hex) => `<base name="Color ${hex}" displaycolor="${hex}"/>`);
  const items = bodies.map((_body, index) => `<item objectid="${index + firstObjectId}"/>`);
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="${coreNamespace}"><metadata name="Application">Tau gallery / Classic OpenSCAD</metadata><resources><basematerials id="${materialResourceId}">${materials.join('')}</basematerials>${objects.join('')}</resources><build>${items.join('')}</build></model>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${relationshipNamespace}"><Relationship Target="/${modelPart}" Id="rel0" Type="${modelRelationship}"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="${modelContentType}"/></Types>`;
  return new Uint8Array(
    zipSync(
      {
        '[Content_Types].xml': strToU8(contentTypes),
        '_rels/.rels': strToU8(relationships),
        [modelPart]: strToU8(model),
      },
      { level: 6, mtime: new Date(1980, 0, 1) },
    ),
  );
};
