/* oxlint-disable eslint(new-cap), @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-plus-operands -- OpenCascade API is untyped at runtime with PascalCase methods */
/**
 * OpenCascade shape meshing and GLTF conversion utilities.
 *
 * Meshes TopoDS_Shape objects using BRepMesh_IncrementalMesh and extracts
 * triangulation data via Poly_Triangulation, then converts to GLB via gltf-transform.
 */

import type { Primitive } from '@gltf-transform/core';
import { Document, NodeIO } from '@gltf-transform/core';
import { cadMaterialDefaults } from '@taucad/types/constants';
import { transformVertexArray, transformNormalArray } from '#framework/common.js';

type ShapeEntry = {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches OpenCASCADE API method name
  shape: { IsNull: () => boolean };
  name?: string;
  color?: string;
  opacity?: number;
};

type MeshOptions = {
  linearTolerance: number;
  angularTolerance: number;
};

type FaceTriangulation = {
  positions: Float32Array<ArrayBuffer>;
  normals: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
};

function extractFaceTriangulation(oc: any, shape: any, options: MeshOptions): FaceTriangulation {
  const mesh = new oc.BRepMesh_IncrementalMeshWrapper(
    shape,
    options.linearTolerance,
    false,
    options.angularTolerance,
    false,
  );

  const allPositions: number[] = [];
  const allNormals: number[] = [];
  const allIndices: number[] = [];
  let vertexOffset = 0;

  const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);

  while (explorer.More()) {
    const face = oc.TopoDS_Cast.Face(explorer.Current());
    const location = new oc.TopLoc_Location_1();
    const triangulation = oc.BRep_Tool.Triangulation(face, location, 0);

    if (triangulation.IsNull()) {
      explorer.Next();
      continue;
    }

    const nbNodes = triangulation.get().NbNodes();
    const nbTriangles = triangulation.get().NbTriangles();
    const transformation = location.Transformation();

    for (let i = 1; i <= nbNodes; i++) {
      const node = triangulation.get().Node(i);
      const transformed = node.Transformed(transformation);
      allPositions.push(transformed.X(), transformed.Y(), transformed.Z());
    }

    const hasNormals = triangulation.get().HasNormals();
    if (hasNormals) {
      for (let i = 1; i <= nbNodes; i++) {
        const normal = triangulation.get().Normal(i);
        allNormals.push(normal.X(), normal.Y(), normal.Z());
      }
    } else {
      for (let i = 1; i <= nbNodes; i++) {
        allNormals.push(0, 1, 0);
      }
    }

    const orientation = face.Orientation();
    const reversed = orientation === oc.TopAbs_Orientation.TopAbs_REVERSED;

    for (let i = 1; i <= nbTriangles; i++) {
      const tri = triangulation.get().Triangle(i);
      const n1 = tri.Value(1) - 1 + vertexOffset;
      const n2 = tri.Value(2) - 1 + vertexOffset;
      const n3 = tri.Value(3) - 1 + vertexOffset;

      if (reversed) {
        allIndices.push(n1, n3, n2);
      } else {
        allIndices.push(n1, n2, n3);
      }
    }

    vertexOffset += nbNodes;
    location.delete();
    explorer.Next();
  }

  explorer.delete();
  mesh.delete();

  return {
    positions: transformVertexArray(allPositions),
    normals: transformNormalArray(allNormals),
    indices: new Uint32Array(allIndices),
  };
}

function parseHexColor(hex: string): [number, number, number, number] {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b, 1];
}

function createPrimitive(
  document: Document,
  options: {
    buffer: ReturnType<Document['createBuffer']>;
    tri: FaceTriangulation;
    color: [number, number, number, number];
  },
): Primitive {
  const { buffer, tri, color } = options;

  const posAccessor = document.createAccessor().setArray(tri.positions).setType('VEC3').setBuffer(buffer);

  const normalAccessor = document.createAccessor().setArray(tri.normals).setType('VEC3').setBuffer(buffer);

  const indexAccessor = document.createAccessor().setArray(tri.indices).setType('SCALAR').setBuffer(buffer);

  const material = document
    .createMaterial()
    .setDoubleSided(true)
    .setMetallicFactor(cadMaterialDefaults.metallicFactor)
    .setRoughnessFactor(cadMaterialDefaults.roughnessFactor)
    .setBaseColorFactor(color);

  return document
    .createPrimitive()
    .setAttribute('POSITION', posAccessor)
    .setAttribute('NORMAL', normalAccessor)
    .setIndices(indexAccessor)
    .setMaterial(material);
}

/**
 * Mesh OpenCascade shapes and serialize to a glTF binary buffer.
 * @param oc - OpenCASCADE WASM instance
 * @param shapes - Shapes with optional color/opacity metadata
 * @param options - Meshing parameters (linear deflection, angular deflection)
 * @returns Serialized glTF binary (.glb) as a Uint8Array
 */
export async function meshShapesToGltf(
  oc: any,
  shapes: ShapeEntry[],
  options: MeshOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const document = new Document();
  const scene = document.createScene();
  const buffer = document.createBuffer();

  for (const entry of shapes) {
    if (entry.shape.IsNull()) {
      continue;
    }

    const tri = extractFaceTriangulation(oc, entry.shape, options);
    if (tri.indices.length === 0) {
      continue;
    }

    const color: [number, number, number, number] = entry.color
      ? parseHexColor(entry.color)
      : [0.8, 0.8, 0.8, entry.opacity ?? 1];

    if (entry.opacity !== undefined) {
      color[3] = entry.opacity;
    }

    const primitive = createPrimitive(document, { buffer, tri, color });
    const mesh = document.createMesh(entry.name ?? 'Shape').addPrimitive(primitive);
    const node = document.createNode(entry.name ?? 'Shape').setMesh(mesh);
    scene.addChild(node);
  }

  const io = new NodeIO();
  return io.writeBinary(document);
}
