import { expect, it } from 'vitest';
import {
  threeMfFixture,
  triangleModelXml,
  wavefrontTriangleFixture,
  triangleStepFixture,
} from '#scripts/export-artifacts.fixture.js';
import {
  validateWavefrontStructure,
  validateStepStructure,
  validateThreeMfStructure,
} from '#scripts/export-structure.js';
import { validateExportArtifact } from '#scripts/verification-artifacts.js';

it('should validate actual 3MF ZIP manifests, finite triangle records and build references', () => {
  expect(validateThreeMfStructure(threeMfFixture())).toEqual({
    models: 1,
    objects: 1,
    meshes: 1,
    vertices: 3,
    triangles: 1,
    buildItems: 1,
  });
});

it('should reject missing or malformed 3MF geometry and object references', () => {
  expect(() => validateThreeMfStructure(threeMfFixture(triangleModelXml.replace('v3="2"', 'v3="3"')))).toThrow(
    'missing vertex',
  );
  expect(() => validateThreeMfStructure(threeMfFixture(triangleModelXml.replace('v3="2"', 'v3=""')))).toThrow(
    'must be an integer',
  );
  expect(() =>
    validateThreeMfStructure(threeMfFixture(triangleModelXml.replace('objectid="1"', 'objectid="2"'))),
  ).toThrow('missing object');
  expect(() => validateThreeMfStructure(threeMfFixture(triangleModelXml.replace('x="1"', 'x="NaN"')))).toThrow(
    'invalid x',
  );
  expect(() => validateThreeMfStructure(threeMfFixture(triangleModelXml.replace('</model>', '')))).toThrow(
    'unclosed tag',
  );
});

it('should reject a 3MF build that reaches an empty object or a component cycle', () => {
  const empty = triangleModelXml
    .replace('</resources>', '<object id="2" type="model"/></resources>')
    .replace('objectid="1"', 'objectid="2"');
  expect(() => validateThreeMfStructure(threeMfFixture(empty))).toThrow('empty object');
  const cyclic = triangleModelXml
    .replace('</resources>', '<object id="2"><components><component objectid="2"/></components></object></resources>')
    .replace('<item objectid="1"', '<item objectid="2"');
  expect(() => validateThreeMfStructure(threeMfFixture(cyclic))).toThrow('reference cycle');
});

it('should record STEP as a structural check without claiming BRep validity', async () => {
  const result = await validateExportArtifact({
    format: 'step',
    files: [{ name: 'fixture.step', mimeType: 'model/step', bytes: triangleStepFixture }],
    reference: { boundsMm: { min: [0, 0, 0], max: [1, 2, 0], size: [1, 2, 0] } },
  });
  expect(result).toMatchObject({ level: 'structure', counts: { files: 1, entities: 4, points: 3, surfaces: 1 } });
  expect(result.boundsMm).toBeUndefined();
  expect(() => validateStepStructure(new TextEncoder().encode('ISO-10303-21;END-ISO-10303-21;'))).toThrow(
    'header, schema or data',
  );
});

it('should validate OBJ face indices in both directions and reject missing vertices', () => {
  expect(validateWavefrontStructure(wavefrontTriangleFixture)).toEqual({
    vertices: 3,
    textures: 0,
    normals: 0,
    faces: 1,
  });
  const text = new TextDecoder().decode(wavefrontTriangleFixture);
  expect(validateWavefrontStructure(new TextEncoder().encode(text.replace('f 1 2 3', 'f -3 -2 -1')))['faces']).toBe(1);
  expect(() => validateWavefrontStructure(new TextEncoder().encode(text.replace('f 1 2 3', 'f 1 2 4')))).toThrow(
    'missing vertex',
  );
  expect(() => validateWavefrontStructure(new TextEncoder().encode(text.replace('f 1 2 3', 'f -4 -2 -1')))).toThrow(
    'missing vertex',
  );
  expect(() => validateWavefrontStructure(new TextEncoder().encode(text.replace('v 1 0 0', 'v Infinity 0 0')))).toThrow(
    'invalid coordinates',
  );
});

it('should reject STEP entity-like comments and strings when DATA has no geometric records', () => {
  const source = new TextDecoder().decode(triangleStepFixture);
  const commentsOnly = source.replace(/DATA;([\s\S]*?)ENDSEC;/u, 'DATA;/*$1*/ENDSEC;');
  expect(() => validateStepStructure(new TextEncoder().encode(commentsOnly))).toThrow('entity IDs are empty');
  const stringsOnly = source.replace(
    /DATA;[\s\S]*?ENDSEC;/u,
    "DATA;#1=DESCRIPTIVE_REPRESENTATION_ITEM('CARTESIAN_POINT(1,2,3) POLY_LOOP(1,2,3)');ENDSEC;",
  );
  expect(() => validateStepStructure(new TextEncoder().encode(stringsOnly))).toThrow('no geometric surface entities');
});
