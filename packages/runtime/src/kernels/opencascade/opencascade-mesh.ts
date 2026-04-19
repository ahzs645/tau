/* oxlint-disable eslint(new-cap) -- OpenCascade API uses PascalCase method names */
/**
 * OpenCascade shape meshing and native GLB export via RWGltf_CafWriter.
 *
 * Uses OpenCASCADE's native XCAF document + RWGltf_CafWriter to produce GLB
 * directly, eliminating manual vertex extraction and the gltf-transform dependency.
 */

import { cadMaterialDefaults } from '@taucad/types/constants';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- internal # imports resolve to self
import type { OpenCascadeInstance } from '#kernels/opencascade/wasm/opencascade_full.js';
import type { ShapeEntry } from '#kernels/opencascade/opencascade.types.js';

type MeshOptions = {
  linearTolerance: number;
  angularTolerance: number;
  coordinateSystem?: 'y-up' | 'z-up';
};

/**
 * Parse a hex color string into an RGB tuple.
 *
 * @param hex - The hex color string to parse.
 * @returns The RGB tuple.
 * @public
 */
export function parseHexColor(hex: string): [number, number, number] {
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
  const documentName = new oc.TCollection_ExtendedString();
  const document = new oc.TDocStd_Document(documentName);
  const mainLabel = document.Main();
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(mainLabel);
  const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(mainLabel);

  const labels: Array<{ delete(): void }> = [];

  for (const entry of shapes) {
    if (entry.shape.IsNull()) {
      continue;
    }

    oc.BRepTools.Clean(entry.shape, false);
    const mesh = new oc.BRepMesh_IncrementalMesh(
      entry.shape,
      options.linearTolerance,
      false,
      options.angularTolerance,
      false,
    );

    const label = shapeTool.NewShape();
    labels.push(label);
    shapeTool.SetShape(label, entry.shape);

    if (entry.color) {
      const [r, g, b] = parseHexColor(entry.color);
      const color = new oc.Quantity_Color(r, g, b, oc.Quantity_TypeOfColor.Quantity_TOC_sRGB);
      colorTool.SetColor(label, color, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
      color.delete();
    }

    if (entry.metalness !== undefined || entry.roughness !== undefined) {
      const visTool = oc.XCAFDoc_DocumentTool.VisMaterialTool(mainLabel);
      const pbrMat = new oc.XCAFDoc_VisMaterialPBR();
      if (entry.color) {
        const [r, g, b] = parseHexColor(entry.color);
        const baseColor = new oc.Quantity_ColorRGBA(r, g, b, entry.opacity ?? 1);
        pbrMat.BaseColor = baseColor;
        baseColor.delete();
      }
      pbrMat.Metallic = entry.metalness ?? cadMaterialDefaults.metalnessFactor;
      pbrMat.Roughness = entry.roughness ?? cadMaterialDefaults.roughnessFactor;
      pbrMat.IsDefined = true;
      const visMat = new oc.XCAFDoc_VisMaterial();
      visMat.SetPbrMaterial(pbrMat);
      const matName = new oc.TCollection_AsciiString(entry.name ?? 'material');
      const visMatLabel = visTool.AddMaterial(visMat, matName);
      visTool.SetShapeMaterial(label, visMatLabel);
      matName.delete();
      visMatLabel.delete();
      visMat.delete();
      pbrMat.delete();
      visTool.delete();
    }

    mesh.delete();
  }

  const outputPath = `/tmp/export_${Date.now()}.glb`;
  const writerPath = new oc.TCollection_AsciiString(outputPath);
  const writer = new oc.RWGltf_CafWriter(writerPath, true);

  const converter = new oc.RWMesh_CoordinateSystemConverter();
  converter.SetInputLengthUnit(0.001);
  converter.SetInputCoordinateSystem(oc.RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup);
  converter.SetOutputLengthUnit(1);
  const outputSystem =
    options.coordinateSystem === 'z-up'
      ? oc.RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup
      : oc.RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_glTF;
  converter.SetOutputCoordinateSystem(outputSystem);
  writer.SetCoordinateSystemConverter(converter);

  const pbrMat = new oc.XCAFDoc_VisMaterialPBR();
  pbrMat.Metallic = cadMaterialDefaults.metalnessFactor;
  pbrMat.Roughness = cadMaterialDefaults.roughnessFactor;
  const visMat = new oc.XCAFDoc_VisMaterial();
  visMat.SetPbrMaterial(pbrMat);
  const defaultStyle = new oc.XCAFPrs_Style();
  defaultStyle.SetMaterial(visMat);
  writer.SetDefaultStyle(defaultStyle);

  const progress = new oc.Message_ProgressRange();
  const fileInfo = new oc.TColStd_IndexedDataMapOfStringString();
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- WASM binding enum type mismatch
  writer.Perform(document, fileInfo as unknown, progress);

  const glbData = oc.FS.readFile(outputPath, { encoding: 'binary' }) as Uint8Array<ArrayBuffer>;
  const result = new Uint8Array(glbData);

  oc.FS.unlink(outputPath);
  for (const label of labels) {
    label.delete();
  }
  fileInfo.delete();
  defaultStyle.delete();
  visMat.delete();
  pbrMat.delete();
  converter.delete();
  progress.delete();
  writerPath.delete();
  writer.delete();
  colorTool.delete();
  shapeTool.delete();
  mainLabel.delete();
  documentName.delete();
  document.delete();

  return result;
}
