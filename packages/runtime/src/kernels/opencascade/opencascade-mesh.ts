/* oxlint-disable new-cap -- OpenCascade API uses PascalCase method names */
/**
 * OpenCascade shape meshing and native GLB export via RWGltf_CafWriter.
 *
 * Uses OpenCASCADE's native XCAF document + RWGltf_CafWriter to produce GLB
 * directly, eliminating manual vertex extraction and the gltf-transform dependency.
 */

import { Accessor, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { cadMaterialDefaults } from '@taucad/types/constants';
import type { OpenCascadeInstance, TopoDS_Edge, gp_Pnt } from '#kernels/opencascade/wasm/opencascade_full.js';
import type { ShapeEntry } from '#kernels/opencascade/opencascade.types.js';
import { srgbToLinear } from '#utils/color-space.js';
import { nativeEdgesNodeName } from '#utils/merge-gltf-edges.js';

type MeshOptions = {
  linearTolerance: number;
  angularTolerance: number;
  coordinateSystem?: 'y-up' | 'z-up';
  includeBrepEdges?: boolean;
};

type BrepEdgeSamplingContext = {
  oc: OpenCascadeInstance;
  options: MeshOptions;
  output: number[];
};

type AddNativeBrepEdgesOptions = {
  oc: OpenCascadeInstance;
  glb: Uint8Array<ArrayBuffer>;
  shapes: ShapeEntry[];
  options: MeshOptions;
};

const edgeColor: [number, number, number, number] = [0, 0, 0, 1];
const primitiveModeLines = 1;
const millimetersToMeters = 0.001;

/**
 * RWGltf_CafWriter may merge or reorder meshes relative to `ShapeEntry` order.
 * Assign `ShapeConfig.name` onto the first `min(meshes, entries)` glTF meshes,
 * then propagate mesh names to parent nodes when nodes are anonymous — mirrors
 * the invariants `analyzeGlb` relies on for per-part feedback.
 *
 * @param glb - GLB bytes emitted by RWGltf_CafWriter.
 * @param entries - Source shape entries whose names should annotate meshes.
 * @returns The tagged GLB.
 */
const tagGlbMeshAndNodesFromShapeEntries = async (
  glb: Uint8Array<ArrayBuffer>,
  entries: ShapeEntry[],
): Promise<Uint8Array<ArrayBuffer>> => {
  if (entries.length === 0) {
    return glb;
  }
  const io = new NodeIO();
  const document = await io.readBinary(glb);
  const meshes = document.getRoot().listMeshes();
  const limit = Math.min(meshes.length, entries.length);
  for (let i = 0; i < limit; i++) {
    const label = entries[i]?.name;
    if (label) {
      meshes[i]!.setName(label);
    }
  }
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const meshName = mesh?.getName().trim();
    if (meshName && node.getName().trim() === '') {
      node.setName(meshName);
    }
  }
  return io.writeBinary(document);
};

function pushTransformedPoint(
  point: gp_Pnt,
  coordinateSystem: MeshOptions['coordinateSystem'],
  output: number[],
): void {
  const x = point.X();
  const y = point.Y();
  const z = point.Z();

  if (coordinateSystem === 'z-up') {
    output.push(x * millimetersToMeters, y * millimetersToMeters, z * millimetersToMeters);
    return;
  }

  // OpenCASCADE authoring space is Z-up/mm. RWGltf_CafWriter exports glTF
  // Y-up/meters with x'=x, y'=z, z'=-y, so sampled native edges must match.
  output.push(x * millimetersToMeters, z * millimetersToMeters, -y * millimetersToMeters);
}

function sampleBrepEdge(edge: TopoDS_Edge, context: BrepEdgeSamplingContext): void {
  const { oc, options, output } = context;
  if (oc.BRep_Tool.Degenerated(edge)) {
    return;
  }

  const curve = new oc.BRepAdaptor_Curve(edge);
  const first = curve.FirstParameter();
  const last = curve.LastParameter();
  if (!Number.isFinite(first) || !Number.isFinite(last) || Math.abs(last - first) <= Number.EPSILON) {
    curve.delete();
    return;
  }

  const deflection = Math.max(options.linearTolerance, 0.01);
  const sampler = new oc.GCPnts_QuasiUniformDeflection(curve, deflection, first, last, oc.GeomAbs_Shape.GeomAbs_C1);
  if (!sampler.IsDone() || sampler.NbPoints() < 2) {
    const start = curve.EvalD0(first);
    const end = curve.EvalD0(last);
    pushTransformedPoint(start, options.coordinateSystem, output);
    pushTransformedPoint(end, options.coordinateSystem, output);
    start.delete();
    end.delete();
    sampler.delete();
    curve.delete();
    return;
  }

  let previousPoint = sampler.Value(1);
  for (let index = 2; index <= sampler.NbPoints(); index += 1) {
    const point = sampler.Value(index);
    pushTransformedPoint(previousPoint, options.coordinateSystem, output);
    pushTransformedPoint(point, options.coordinateSystem, output);
    previousPoint.delete();
    previousPoint = point;
  }
  previousPoint.delete();
  sampler.delete();
  curve.delete();
}

function sampleBrepEdges(
  oc: OpenCascadeInstance,
  shapes: ShapeEntry[],
  options: MeshOptions,
): Float32Array<ArrayBuffer> | undefined {
  const positions: number[] = [];
  const context: BrepEdgeSamplingContext = { oc, options, output: positions };

  for (const entry of shapes) {
    if (entry.shape.IsNull()) {
      continue;
    }

    const explorer = new oc.TopExp_Explorer(
      entry.shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    while (explorer.More()) {
      const edge = oc.TopoDS.Edge(explorer.Current());
      sampleBrepEdge(edge, context);
      explorer.Next();
    }
    explorer.delete();
  }

  if (positions.length === 0) {
    return undefined;
  }

  return new Float32Array(positions);
}

async function addNativeBrepEdgesToGlb({
  oc,
  glb,
  shapes,
  options,
}: AddNativeBrepEdgesOptions): Promise<Uint8Array<ArrayBuffer>> {
  const positions = sampleBrepEdges(oc, shapes, options);
  if (!positions) {
    return glb;
  }

  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);
  const document = await io.readBinary(glb);
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const unlitExtension = document.createExtension(KHRMaterialsUnlit);
  const material = document
    .createMaterial('tau-edge-material')
    .setBaseColorFactor(edgeColor)
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setDoubleSided(true)
    .setExtension('KHR_materials_unlit', unlitExtension.createUnlit());

  const primitive = document
    .createPrimitive()
    .setMode(primitiveModeLines)
    .setMaterial(material)
    .setAttribute(
      'POSITION',
      document
        .createAccessor('tau-native-brep-edge-positions')
        .setBuffer(buffer)
        .setType(Accessor.Type['VEC3']!)
        .setArray(positions),
    );

  const mesh = document.createMesh(nativeEdgesNodeName).addPrimitive(primitive);
  const node = document.createNode(nativeEdgesNodeName).setMesh(mesh);
  const scene = document.getRoot().listScenes()[0] ?? document.createScene();
  scene.addChild(node);

  return io.writeBinary(document);
}

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
export async function meshShapesToGltf(
  oc: OpenCascadeInstance,
  shapes: ShapeEntry[],
  options: MeshOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const documentName = new oc.TCollection_ExtendedString();
  const document = new oc.TDocStd_Document(documentName);
  const mainLabel = document.Main();
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(mainLabel);
  const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(mainLabel);

  const labels: Array<{ delete(): void }> = [];

  for (const [shapeIndex, entry] of shapes.entries()) {
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

    const shapeLabelName = new oc.TCollection_ExtendedString(entry.name ?? `Shape_${shapeIndex}`);
    oc.TDataStd_Name.Set(label, shapeLabelName);
    shapeLabelName.delete();

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
        const [sr, sg, sb] = parseHexColor(entry.color);
        // The 4-double `Quantity_ColorRGBA` constructor treats inputs as
        // **linear** RGB. CSS hex strings are sRGB, so convert per channel —
        // see docs/policy/color-space-policy.md.
        const baseColor = new oc.Quantity_ColorRGBA(
          srgbToLinear(sr),
          srgbToLinear(sg),
          srgbToLinear(sb),
          entry.opacity ?? 1,
        );
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

  const taggedResult = await tagGlbMeshAndNodesFromShapeEntries(result, shapes);
  if (options.includeBrepEdges) {
    return addNativeBrepEdgesToGlb({ oc, glb: taggedResult, shapes, options });
  }

  return taggedResult;
}
