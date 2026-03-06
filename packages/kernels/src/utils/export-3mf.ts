import UZIP from 'uzip';
import { converter, serializeHex } from 'culori';
import type { IndexedPolyhedron } from '#framework/common.js';

// Convert culori RGB to color objects for distance calculations
const toRgb = converter('rgb');

/**
 * Calculate color distance using simple Euclidean distance in RGB space
 *
 * @param color1 - first RGB color with values 0-1
 * @param color2 - second RGB color with values 0-1
 * @returns the Euclidean distance between the two colors
 */
function calculateColorDistance(color1: [number, number, number], color2: [number, number, number]): number {
  const [r1, g1, b1] = color1;
  const [r2, g2, b2] = color2;
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

/**
 * Get color mapping from model colors to extruder colors
 *
 * @param colors - the model colors to map
 * @param extruderColors - the available extruder colors to match against
 * @returns array of extruder indices corresponding to each model color
 */
function getColorMapping(
  colors: Array<[number, number, number]>,
  extruderColors: Array<[number, number, number]>,
): number[] {
  return colors.map((targetColor) => {
    let closestIndex = 0;
    let minDistance = Infinity;

    for (const [index, extruderColor] of extruderColors.entries()) {
      const distance = calculateColorDistance(targetColor, extruderColor);
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = index;
      }
    }

    return closestIndex;
  });
}

// Reverse-engineered from PrusaSlicer / BambuStudio's output.
const paintColorMap = ['', '8', '0C', '1C', '2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', 'AC', 'BC', 'CC', 'DC'];

/**
 * Convert RGB values (0-1) to hex color string
 *
 * @param rgb - RGB color with values 0-1
 * @returns the hex color string (e.g. "#ff0000")
 */
function rgbToHex(rgb: [number, number, number]): string {
  const [r, g, b] = rgb;
  const rgbColor = toRgb({ mode: 'rgb', r, g, b });
  return serializeHex(rgbColor);
}

/**
 * Triangulate a face using fan triangulation
 *
 * @param face - array of vertex indices forming the face polygon
 * @param colorIndex - the color index to assign to each resulting triangle
 * @returns array of triangles with vertex index triples and color indices
 */
function triangulateFace(
  face: number[],
  colorIndex: number,
): Array<{ vertices: [number, number, number]; colorIndex: number }> {
  if (face.length < 3) {
    return [];
  }

  // Validate that all face indices are valid numbers
  if (face.some((index) => typeof index !== 'number' || index < 0 || !Number.isInteger(index))) {
    throw new Error(`Invalid face indices: ${face.join(', ')}`);
  }

  const triangles: Array<{
    vertices: [number, number, number];
    colorIndex: number;
  }> = [];

  // Fan triangulation: connect first vertex to all other triangles
  for (let index = 1; index < face.length - 1; index++) {
    const v0 = face[0];
    const v1 = face[index];
    const v2 = face[index + 1];

    if (v0 === undefined || v1 === undefined || v2 === undefined) {
      throw new Error(`Undefined vertex index in face: [${face.join(', ')}] at triangle ${index}`);
    }

    triangles.push({
      vertices: [v0, v1, v2],
      colorIndex,
    });
  }

  return triangles;
}

/**
 * Converts an IndexedPolyhedron to a 3MF ZIP archive with optional multi-material support.
 *
 * @param data - the polyhedron geometry (vertices, faces, colors) to export
 * @param extruderColors - optional extruder RGB colors for multi-material printing color mapping
 * @returns the 3MF file as a ZIP-compressed byte array
 * @throws When the geometry has no vertices or faces
 */
export function export3mf(
  data: IndexedPolyhedron,
  extruderColors?: Array<[number, number, number]>,
): Uint8Array<ArrayBuffer> {
  const objectUuid = crypto.randomUUID();
  const buildUuid = crypto.randomUUID();

  // Early return for empty geometry
  if (data.vertices.length === 0 || data.faces.length === 0) {
    throw new Error('Empty geometry');
  }

  // Ensure we have at least one color (default to white)
  // 3MF format only supports RGB (no alpha), so we extract just the RGB components
  const colors: Array<[number, number, number]> =
    data.colors.length > 0 ? data.colors.map((color) => [color[0], color[1], color[2]]) : [[1, 1, 1]];

  // Convert face indices to triangulated faces with color information
  const triangulatedFaces: Array<{
    vertices: [number, number, number];
    colorIndex: number;
  }> = [];

  for (const [faceIndex, face] of data.faces.entries()) {
    // Use face index as color index, clamped to available colors (with safe fallback)
    const colorIndex = Math.max(0, Math.min(faceIndex, colors.length - 1));

    try {
      const triangles = triangulateFace(face, colorIndex);
      triangulatedFaces.push(...triangles);
    } catch (error) {
      console.warn(`Failed to triangulate face ${faceIndex}:`, error);
      // Skip invalid faces instead of crashing
      continue;
    }
  }

  // Calculate extruder mapping if provided
  let extruderIndexByColorIndex: number[] | undefined;
  let paintColorByColorIndex: string[] | undefined;

  if (extruderColors) {
    extruderIndexByColorIndex = getColorMapping(colors, extruderColors);
    paintColorByColorIndex = extruderIndexByColorIndex.map((index) => paintColorMap[index] ?? '');

    console.log('Extruder colors:');
    for (const [index, color] of extruderColors.entries()) {
      console.log(`- ${index}: ${rgbToHex(color)}`);
    }

    console.log('Model color mapping:');
    for (const [index, fromColor] of colors.entries()) {
      const extruderIndex = extruderIndexByColorIndex[index]!;
      const toColor = extruderColors[extruderIndex];
      console.log(
        `- ${rgbToHex(fromColor)} -> ${toColor ? rgbToHex(toColor) : 'unknown'} (${paintColorMap[extruderIndex] ?? ''})`,
      );
    }
  }

  // Create the 3D model XML content
  const modelXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
    '  <meta name="BambuStudio:3mfVersion" value="1"/>',
    '  <meta name="slic3rpe:Version3mf" value="1"/>',
    '  <meta name="slic3rpe:MmPaintingVersion" value="1"/>',
    '  <resources>',
    '    <basematerials id="2">',
    ...colors.map((color, index) => `      <base name="color_${index}" displaycolor="${rgbToHex(color)}"/>`),
    '    </basematerials>',
    `    <object id="1" name="OpenSCAD Model" type="model" p:UUID="${objectUuid}" pid="2" pindex="0">`,
    '      <mesh>',
    '        <vertices>',
    ...data.vertices.map((vertex) => `          <vertex x="${vertex[0]}" y="${vertex[1]}" z="${vertex[2]}" />`),
    '        </vertices>',
    '        <triangles>',
    ...triangulatedFaces.map((triangle) => {
      const { vertices, colorIndex } = triangle;
      const attributes = vertices.map((v, i) => `v${i + 1}="${v}"`);

      if (colorIndex > 0) {
        attributes.push(`pid="2" p1="${colorIndex}"`);
      }

      const paintColor = paintColorByColorIndex?.[colorIndex];
      if (paintColor) {
        attributes.push(`paint_color="${paintColor}"`);
      }

      return `          <triangle ${attributes.join(' ')} />`;
    }),
    '        </triangles>',
    '      </mesh>',
    '    </object>',
    '  </resources>',
    `  <build p:UUID="${buildUuid}">`,
    `    <item objectid="1" p:UUID="${objectUuid}"/>`,
    '  </build>',
    '</model>',
  ].join('\n');

  // Create the content types XML
  const contentTypesXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
    '</Types>',
  ].join('\n');

  // Create the relationships XML
  const relsXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model" Id="rel0"/>',
    '</Relationships>',
  ].join('\n');

  // Create the ZIP archive using UZIP
  const archive: Record<string, Uint8Array<ArrayBuffer>> = {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- 3MF file format requires this naming convention
    '3D/3dmodel.model': new TextEncoder().encode(modelXml),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- 3MF file format requires this naming convention
    '[Content_Types].xml': new TextEncoder().encode(contentTypesXml),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- 3MF file format requires this naming convention
    '_rels/.rels': new TextEncoder().encode(relsXml),
  };

  // Generate the ZIP buffer

  const zipBuffer = UZIP.encode(archive);
  return new Uint8Array(zipBuffer);
}
