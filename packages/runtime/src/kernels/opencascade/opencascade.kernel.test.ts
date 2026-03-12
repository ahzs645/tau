// @vitest-environment node
/* eslint-disable @typescript-eslint/naming-convention -- File names use extensions like 'box.ts' */
import { describe, it, expect, beforeAll } from 'vitest';
import opencascadeKernel from '#kernels/opencascade/opencascade.kernel.js';
import { assertSuccess, createGeometryFile, createTestWorker } from '#testing/kernel-testing.utils.js';
import { createGeometryTestHelpers } from '#testing/kernel-geometry-testing.utils.js';

// =============================================================================
// Test Utilities
// =============================================================================

const geometryHelpers = createGeometryTestHelpers();

// =============================================================================
// All tests share a single worker to avoid Embind type registry conflicts
// that occur when initializing multiple WASM instances in the same process.
// =============================================================================

describe('OpenCascade Kernel', { timeout: 30_000 }, () => {
  let worker: Awaited<ReturnType<typeof createTestWorker>>;

  beforeAll(async () => {
    worker = await createTestWorker(opencascadeKernel, {
      'box-import.ts': `import { BRepPrimAPI_MakeBox_2 } from 'opencascade';\nexport default function main() { return new BRepPrimAPI_MakeBox_2(10, 10, 10).Shape(); }`,
      'box-import-js.ts': `import { BRepPrimAPI_MakeBox_2 } from 'opencascade.js';\nexport default function main() { return new BRepPrimAPI_MakeBox_2(10, 10, 10).Shape(); }`,
      'no-import.ts': `export default function main() { return { x: 1 }; }`,
      'model.scad': `cube([10, 10, 10]);`,
      'box-require.js': `const { BRepPrimAPI_MakeBox_2 } = require('opencascade');\nmodule.exports = function main() { return new BRepPrimAPI_MakeBox_2(10, 10, 10).Shape(); }`,
      'params.ts': `
import { BRepPrimAPI_MakeBox_2 } from 'opencascade';
export const defaultParams = { width: 10, height: 20, depth: 30 };
export default function main(params = defaultParams) {
  return new BRepPrimAPI_MakeBox_2(params.width, params.height, params.depth).Shape();
}`,
      'no-params.ts': `
import { BRepPrimAPI_MakeBox_2 } from 'opencascade';
export default function main() {
  return new BRepPrimAPI_MakeBox_2(10, 20, 30).Shape();
}`,
      'box.ts': `
import { BRepPrimAPI_MakeBox_2 } from 'opencascade';
export default function main() {
  const box = new BRepPrimAPI_MakeBox_2(10, 20, 30);
  return box.Shape();
}`,
      'multi.ts': `
import { BRepPrimAPI_MakeBox_2 } from 'opencascade';
export default function main() {
  const box1 = new BRepPrimAPI_MakeBox_2(10, 10, 10);
  const box2 = new BRepPrimAPI_MakeBox_2(20, 20, 20);
  return [box1.Shape(), box2.Shape()];
}`,
      'named.ts': `
import { BRepPrimAPI_MakeBox_2 } from 'opencascade';
export default function main() {
  const box = new BRepPrimAPI_MakeBox_2(10, 10, 10);
  return [{ shape: box.Shape(), name: 'MyBox', color: '#ff0000' }];
}`,
      'parameterized.ts': `
import { BRepPrimAPI_MakeBox_2 } from 'opencascade';
export const defaultParams = { size: 10 };
export default function main(params = defaultParams) {
  return new BRepPrimAPI_MakeBox_2(params.size, params.size, params.size).Shape();
}`,
      'assembly.ts': `
import { BRepPrimAPI_MakeBox_2 } from 'opencascade';
export default function main() {
  const box1 = new BRepPrimAPI_MakeBox_2(10, 10, 10);
  const box2 = new BRepPrimAPI_MakeBox_2(20, 20, 20);
  return [
    { shape: box1.Shape(), name: 'SmallBox' },
    { shape: box2.Shape(), name: 'LargeBox' },
  ];
}`,
      'fuse.ts': `
import { BRepPrimAPI_MakeBox_2, Message_ProgressRange, BRepAlgoAPI_Fuse } from 'opencascade';
export default function main() {
  const box1 = new BRepPrimAPI_MakeBox_2(10, 10, 10).Shape();
  const box2 = new BRepPrimAPI_MakeBox_2(10, 10, 10).Shape();
  const progress = new Message_ProgressRange();
  const fused = new BRepAlgoAPI_Fuse(box1, box2, progress);
  const result = fused.Shape();
  progress.delete();
  fused.delete();
  return result;
}`,
      'common.ts': `
import { BRepPrimAPI_MakeBox_2, Message_ProgressRange, BRepAlgoAPI_Common } from 'opencascade';
export default function main() {
  const box1 = new BRepPrimAPI_MakeBox_2(20, 20, 20).Shape();
  const box2 = new BRepPrimAPI_MakeBox_2(10, 10, 10).Shape();
  const progress = new Message_ProgressRange();
  const common = new BRepAlgoAPI_Common(box1, box2, progress);
  const result = common.Shape();
  progress.delete();
  common.delete();
  return result;
}`,
      'cut.ts': `
import { BRepPrimAPI_MakeBox_2, Message_ProgressRange, BRepAlgoAPI_Cut } from 'opencascade';
export default function main() {
  const box1 = new BRepPrimAPI_MakeBox_2(20, 20, 20).Shape();
  const box2 = new BRepPrimAPI_MakeBox_2(10, 10, 10).Shape();
  const progress = new Message_ProgressRange();
  const cut = new BRepAlgoAPI_Cut(box1, box2, progress);
  const result = cut.Shape();
  progress.delete();
  cut.delete();
  return result;
}`,
      'fillet.ts': `
import { BRepPrimAPI_MakeBox_2, BRepFilletAPI_MakeFillet, ChFi3d_FilletShape, TopExp_Explorer, TopAbs_ShapeEnum, TopoDS } from 'opencascade';
export default function main() {
  const box = new BRepPrimAPI_MakeBox_2(20, 20, 20).Shape();
  const fillet = new BRepFilletAPI_MakeFillet(box, ChFi3d_FilletShape.ChFi3d_Rational);
  const explorer = new TopExp_Explorer(box, TopAbs_ShapeEnum.TopAbs_EDGE, TopAbs_ShapeEnum.TopAbs_SHAPE);
  if (explorer.More()) {
    const edge = TopoDS.Edge(explorer.Current());
    fillet.Add_2(2, edge);
  }
  explorer.delete();
  const result = fillet.Shape();
  fillet.delete();
  return result;
}`,
      'transform.ts': `
import { BRepPrimAPI_MakeBox_2, gp_Trsf, gp_Vec_4, BRepBuilderAPI_Transform } from 'opencascade';
export default function main() {
  const box = new BRepPrimAPI_MakeBox_2(10, 10, 10).Shape();
  const trsf = new gp_Trsf();
  const vec = new gp_Vec_4(50, 50, 50);
  trsf.SetTranslation(vec);
  const transformed = new BRepBuilderAPI_Transform(box, trsf, true, false);
  const result = transformed.Shape();
  vec.delete();
  trsf.delete();
  transformed.delete();
  return result;
}`,
      'compound.ts': `
import { TopoDS_Builder, TopoDS_Compound, BRepPrimAPI_MakeBox_2 } from 'opencascade';
export default function main() {
  const builder = new TopoDS_Builder();
  const compound = new TopoDS_Compound();
  builder.MakeCompound(compound);
  const box1 = new BRepPrimAPI_MakeBox_2(10, 10, 10).Shape();
  const box2 = new BRepPrimAPI_MakeBox_2(5, 5, 5).Shape();
  builder.Add(compound, box1);
  builder.Add(compound, box2);
  return compound;
}`,
      'empty.ts': `
import init from 'opencascade';
export default function main() {}`,
    });
  });

  // =============================================================================
  // canHandle
  // =============================================================================

  describe('canHandle', () => {
    it('should handle files importing from opencascade', async () => {
      const result = await worker.canHandle(createGeometryFile('box-import.ts'));
      expect(result).toBe(true);
    });

    it('should handle files importing from opencascade.js', async () => {
      const result = await worker.canHandle(createGeometryFile('box-import-js.ts'));
      expect(result).toBe(true);
    });

    it('should not handle files without opencascade imports', async () => {
      const result = await worker.canHandle(createGeometryFile('no-import.ts'));
      expect(result).toBe(false);
    });

    it('should not handle non-JS/TS files', async () => {
      const result = await worker.canHandle(createGeometryFile('model.scad'));
      expect(result).toBe(false);
    });

    it('should handle files using require', async () => {
      const result = await worker.canHandle(createGeometryFile('box-require.js'));
      expect(result).toBe(true);
    });
  });

  // =============================================================================
  // getParameters
  // =============================================================================

  describe('getParameters', () => {
    it('should extract defaultParams', async () => {
      const geometryFile = createGeometryFile('params.ts');
      const result = await worker.getParameters(geometryFile);
      assertSuccess(result, 'getParameters');
      expect(result.data.defaultParameters).toEqual({ width: 10, height: 20, depth: 30 });
      expect(result.data.jsonSchema).toBeDefined();
    });

    it('should return empty params when none defined', async () => {
      const geometryFile = createGeometryFile('no-params.ts');
      const result = await worker.getParameters(geometryFile);
      assertSuccess(result, 'getParameters empty');
      expect(result.data.defaultParameters).toEqual({});
    });
  });

  // =============================================================================
  // createGeometry + exportGeometry
  // =============================================================================

  describe('geometry and export', () => {
    // -- createGeometry --

    it('should create a box shape and return GLTF', async () => {
      const geometryFile = createGeometryFile('box.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(result, 'box createGeometry');
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      await geometryHelpers.expectValidGltf(result);
    });

    it('should handle parameterized geometry', async () => {
      const geometryFile = createGeometryFile('parameterized.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: { size: 25 } });
      assertSuccess(result, 'parameterized createGeometry');
    });

    it('should handle array of shapes', async () => {
      const geometryFile = createGeometryFile('multi.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(result, 'multi-shape createGeometry');
    });

    it('should handle named shape entries', async () => {
      const geometryFile = createGeometryFile('named.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(result, 'named shapes createGeometry');
    });

    // -- exportGeometry --

    it('should fail export with no geometry', async () => {
      const geometryFile = createGeometryFile('empty.ts');
      await worker.createGeometry({ file: geometryFile, parameters: {} });
      const result = await worker.exportGeometry('step');
      expect(result.success).toBe(false);
    });

    it('should export to STEP format', async () => {
      const geometryFile = createGeometryFile('box.ts');
      const createResult = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(createResult, 'createGeometry for STEP export');

      const exportResult = await worker.exportGeometry('step');
      assertSuccess(exportResult, 'STEP export');
      expect(exportResult.data.length).toBeGreaterThan(0);
      expect(exportResult.data[0]?.bytes).toBeInstanceOf(Uint8Array);
      expect(exportResult.data[0]?.mimeType).toBe('application/step');
    });

    it('should export to STL format', async () => {
      const geometryFile = createGeometryFile('box.ts');
      const createResult = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(createResult, 'createGeometry for STL export');

      const exportResult = await worker.exportGeometry('stl');
      assertSuccess(exportResult, 'STL export');
      expect(exportResult.data.length).toBeGreaterThan(0);
      expect(exportResult.data[0]?.bytes).toBeInstanceOf(Uint8Array);
    });

    it('should export to binary STL format', async () => {
      const geometryFile = createGeometryFile('box.ts');
      const createResult = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(createResult, 'createGeometry for STL-binary export');

      const exportResult = await worker.exportGeometry('stl-binary');
      assertSuccess(exportResult, 'STL-binary export');
      expect(exportResult.data.length).toBeGreaterThan(0);
    });

    it('should export to GLTF format', async () => {
      const geometryFile = createGeometryFile('box.ts');
      const createResult = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(createResult, 'createGeometry for GLTF export');

      const exportResult = await worker.exportGeometry('gltf');
      assertSuccess(exportResult, 'GLTF export');
      expect(exportResult.data[0]?.name).toContain('gltf');
    });

    it('should export to GLB format', async () => {
      const geometryFile = createGeometryFile('box.ts');
      const createResult = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(createResult, 'createGeometry for GLB export');

      const exportResult = await worker.exportGeometry('glb');
      assertSuccess(exportResult, 'GLB export');
      expect(exportResult.data[0]?.name).toContain('glb');
    });

    it('should export STEP assembly with multiple named shapes', async () => {
      const geometryFile = createGeometryFile('assembly.ts');
      const createResult = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(createResult, 'createGeometry for assembly export');

      const exportResult = await worker.exportGeometry('step-assembly');
      assertSuccess(exportResult, 'STEP assembly export');
      expect(exportResult.data.length).toBe(2);
    });

    it('should return error for unsupported export format', async () => {
      const geometryFile = createGeometryFile('box.ts');
      const createResult = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(createResult, 'createGeometry for unsupported format test');

      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentionally invalid format for error-path testing
      const exportResult = await worker.exportGeometry('obj' as unknown as 'step');
      expect(exportResult.success).toBe(false);
    });

    // -- Boolean operations --

    it('should perform boolean union (fuse)', async () => {
      const geometryFile = createGeometryFile('fuse.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(result, 'Boolean fuse');
      await geometryHelpers.expectValidGltf(result);
    });

    it('should perform boolean intersection (common)', async () => {
      const geometryFile = createGeometryFile('common.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(result, 'Boolean common');
      await geometryHelpers.expectValidGltf(result);
    });

    it('should perform boolean difference (cut)', async () => {
      const geometryFile = createGeometryFile('cut.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(result, 'Boolean cut');
      await geometryHelpers.expectValidGltf(result);
    });

    // -- Fillet, Transform, Compound --

    it('should apply fillet to a box edge', async () => {
      const geometryFile = createGeometryFile('fillet.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(result, 'Fillet operation');
      await geometryHelpers.expectValidGltf(result);
    });

    it('should apply a translation transform', async () => {
      const geometryFile = createGeometryFile('transform.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(result, 'Transform operation');
      await geometryHelpers.expectValidGltf(result);
      // OpenCASCADE Z-up mm -> GLTF Y-up m: x'=x/1000, y'=z/1000, z'=-y/1000
      // OpenCASCADE center (55,55,55)mm -> GLTF (0.055, 0.055, -0.055)m
      await geometryHelpers.expectBoundingBoxCenter(result, [0.055, 0.055, -0.055], 0.001);
    });

    it('should build a compound from multiple shapes', async () => {
      const geometryFile = createGeometryFile('compound.ts');
      const result = await worker.createGeometry({ file: geometryFile, parameters: {} });
      assertSuccess(result, 'Compound shape');
      await geometryHelpers.expectValidGltf(result);
    });
  });

  // =============================================================================
  // GD&T (deferred until full opencascade.js build has XCAF symbols)
  // =============================================================================

  describe('GD&T', () => {
    it.skip('should create an XCAF document with dimension annotations', () => {
      // Deferred until full opencascade.js build has XCAF symbols properly bound.
      // This test requires TDocStd_Application, XCAFDoc_DocumentTool, XCAFDimTolObjects_DimensionObject.
    });
  });
});
