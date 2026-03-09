/* oxlint-disable eslint(new-cap) -- OpenCascade API uses PascalCase method names */
/**
 * OpenCascade shape meshing and native GLB export via RWGltf_CafWriter.
 *
 * Uses OpenCASCADE's native XCAF document + RWGltf_CafWriter to produce GLB
 * directly, eliminating manual vertex extraction and the gltf-transform dependency.
 */

import type { OpenCascadeInstance, TopoDS_Shape } from '#kernels/opencascade/wasm/opencascade_full.js';

type ShapeEntry = {
  shape: TopoDS_Shape;
  name?: string;
  color?: string;
  opacity?: number;
};

type MeshOptions = {
  linearTolerance: number;
  angularTolerance: number;
};

function parseHexColor(hex: string): [number, number, number] {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * Mesh OpenCascade shapes and export to GLB using native RWGltf_CafWriter.
 *
 * Creates an XCAF document, adds shapes with optional colors, meshes them,
 * then uses OpenCASCADE's native GLTF writer to produce a binary GLB.
 *
 * @param oc - OpenCASCADE WASM instance
 * @param shapes - Shapes with optional color/opacity metadata
 * @param options - Meshing parameters (linear deflection, angular deflection)
 * @returns GLB binary as a Uint8Array
 */
export function meshShapesToGltf(
  oc: OpenCascadeInstance,
  shapes: ShapeEntry[],
  options: MeshOptions,
): Uint8Array<ArrayBuffer> {
  const document = new oc.TDocStd_Document(new oc.TCollection_ExtendedString_1());
  const mainLabel = document.Main();
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(mainLabel);
  const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(mainLabel);

  for (const entry of shapes) {
    if (entry.shape.IsNull()) {
      continue;
    }

    void new oc.BRepMesh_IncrementalMesh(entry.shape, options.linearTolerance, false, options.angularTolerance, false);

    const label = shapeTool.NewShape();
    shapeTool.SetShape(label, entry.shape);

    if (entry.color) {
      const [r, g, b] = parseHexColor(entry.color);
      const color = new oc.Quantity_Color_3(r, g, b, oc.Quantity_TypeOfColor.Quantity_TOC_sRGB as never);
      colorTool.SetColor_2(label, color, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf as never);
      color.delete();
    }
  }

  const outputPath = `/tmp/export_${Date.now()}.glb`;
  const writer = new oc.RWGltf_CafWriter(new oc.TCollection_AsciiString_3(outputPath), true);

  const converter = new oc.RWMesh_CoordinateSystemConverter();
  converter.SetInputLengthUnit(0.001);
  converter.SetInputCoordinateSystem_2(oc.RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup as never);
  converter.SetOutputLengthUnit(1);
  converter.SetOutputCoordinateSystem_2(oc.RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_glTF as never);
  writer.SetCoordinateSystemConverter(converter);

  const progress = new oc.Message_ProgressRange();
  const fileInfo = new oc.TColStd_IndexedDataMapOfStringString();
  writer.Perform(document, fileInfo as never, progress);

  const glbData = oc.FS.readFile(outputPath, { encoding: 'binary' }) as Uint8Array<ArrayBuffer>;
  const result = new Uint8Array(glbData);

  oc.FS.unlink(outputPath);
  progress.delete();
  writer.delete();
  document.delete();

  return result;
}
