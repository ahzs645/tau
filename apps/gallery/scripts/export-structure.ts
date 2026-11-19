import assert from 'node:assert/strict';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import type { SaxesTagPlain } from 'saxes';

const decoder = new TextDecoder('utf-8', { fatal: true });
const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1);
const integer = (value: string | undefined, label: string, minimum = 0): number => {
  const result = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  assert.ok(Number.isSafeInteger(result) && result >= minimum, `${label} must be an integer ≥ ${minimum}`);
  return result;
};

const parseXml = (bytes: Uint8Array<ArrayBuffer>, onTag: (tag: SaxesTagPlain) => void): void => {
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', onTag);
  parser.write(decoder.decode(bytes)).close();
};

type ObjectReference = { readonly objectId: number; readonly path?: string };
type ModelObject = { hasMesh: boolean; references: ObjectReference[] };
type ModelStructure = {
  readonly objects: ReadonlyMap<number, ModelObject>;
  readonly builds: readonly ObjectReference[];
  readonly counts: Record<string, number>;
};

const checkModelXml = (bytes: Uint8Array<ArrayBuffer>): ModelStructure => {
  const objects = new Map<number, ModelObject>();
  const builds: ObjectReference[] = [];
  const counts = { objects: 0, meshes: 0, vertices: 0, triangles: 0, buildItems: 0 };
  let rootName: string | undefined;
  let inBuild = false;
  let currentObject: ModelObject | undefined;
  let mesh: { vertices: number; triangles: number; maximumIndex: number } | undefined;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => {
    const name = localName(tag.name);
    rootName ??= name;
    switch (name) {
      case 'build': {
        assert.ok(!inBuild, '3MF build sections cannot be nested');
        inBuild = true;
        break;
      }
      case 'object': {
        const id = integer(tag.attributes['id'], '3MF object ID', 1);
        assert.ok(!objects.has(id), `Duplicate 3MF object ${id}`);
        assert.equal(currentObject, undefined, '3MF objects cannot be nested');
        currentObject = { hasMesh: false, references: [] };
        objects.set(id, currentObject);
        counts.objects += 1;
        break;
      }
      case 'mesh': {
        assert.ok(currentObject, '3MF mesh is outside an object');
        assert.equal(mesh, undefined, '3MF meshes cannot be nested');
        mesh = { vertices: 0, triangles: 0, maximumIndex: -1 };
        break;
      }
      case 'vertex': {
        assert.ok(mesh, '3MF vertex is outside a mesh');
        for (const axis of ['x', 'y', 'z']) {
          const value = tag.attributes[axis];
          assert.ok(
            value !== undefined && value.trim() !== '' && Number.isFinite(Number(value)),
            `3MF vertex has invalid ${axis}`,
          );
        }
        mesh.vertices += 1;
        break;
      }
      case 'triangle': {
        assert.ok(mesh, '3MF triangle is outside a mesh');
        for (const key of ['v1', 'v2', 'v3']) {
          mesh.maximumIndex = Math.max(mesh.maximumIndex, integer(tag.attributes[key], `3MF triangle ${key}`));
        }
        mesh.triangles += 1;
        break;
      }
      case 'item':
      case 'component': {
        const objectId = integer(tag.attributes['objectid'], '3MF object reference', 1);
        const referencePath = Object.entries(tag.attributes).find(([key]) => localName(key) === 'path')?.[1];
        const reference = { objectId, ...(referencePath ? { path: referencePath } : {}) };
        if (name === 'item') {
          assert.ok(inBuild, '3MF build item is outside a build section');
          builds.push(reference);
          counts.buildItems += 1;
        } else {
          assert.ok(currentObject, '3MF component is outside an object');
          currentObject.references.push(reference);
        }
        break;
      }
      // No default
    }
  });
  parser.on('closetag', (tag) => {
    switch (localName(tag.name)) {
      case 'mesh': {
        assert.ok(currentObject, '3MF mesh is outside an object');
        assert.ok(mesh && mesh.vertices > 0 && mesh.triangles > 0, '3MF mesh has no triangle geometry');
        assert.ok(mesh.maximumIndex < mesh.vertices, '3MF triangle references a missing vertex');
        counts.meshes += 1;
        counts.vertices += mesh.vertices;
        counts.triangles += mesh.triangles;
        currentObject.hasMesh = true;
        mesh = undefined;
        break;
      }
      case 'object': {
        currentObject = undefined;
        break;
      }
      case 'build': {
        inBuild = false;
        break;
      }
      // No default
    }
  });
  parser.write(decoder.decode(bytes)).close();
  assert.equal(rootName, 'model', '3MF model XML has the wrong root');
  return { counts, objects, builds };
};

const referencedModelPath = (modelPath: string, reference: ObjectReference): string =>
  reference.path === undefined
    ? modelPath
    : reference.path.startsWith('/')
      ? reference.path.slice(1)
      : path.posix.join(path.posix.dirname(modelPath), reference.path);

const checkBuildGeometry = (models: ReadonlyMap<string, ModelStructure>, linkedModels: readonly string[]): void => {
  const checked = new Set<string>();
  const visiting = new Set<string>();
  const visit = (sourcePath: string, reference: ObjectReference): void => {
    const modelPath = referencedModelPath(sourcePath, reference);
    const key = `${modelPath}#${reference.objectId}`;
    assert.ok(!visiting.has(key), `3MF component reference cycle at ${key}`);
    if (checked.has(key)) {
      return;
    }
    const object = models.get(modelPath)?.objects.get(reference.objectId);
    assert.ok(object, `3MF references missing object ${reference.objectId} in ${modelPath}`);
    assert.ok(object.hasMesh || object.references.length > 0, `3MF build reaches an empty object ${key}`);
    visiting.add(key);
    for (const child of object.references) {
      visit(modelPath, child);
    }
    visiting.delete(key);
    checked.add(key);
  };
  for (const [modelPath, model] of models) {
    const references = [...model.builds, ...[...model.objects.values()].flatMap((object) => object.references)];
    for (const reference of references) {
      const target = referencedModelPath(modelPath, reference);
      assert.ok(
        models.get(target)?.objects.has(reference.objectId),
        `3MF references missing object ${reference.objectId} in ${target}`,
      );
    }
  }
  for (const modelPath of linkedModels) {
    for (const reference of models.get(modelPath)?.builds ?? []) {
      visit(modelPath, reference);
    }
  }
};

/** Check the ZIP package, well-formed XML, finite vertices, triangle indices and build references. */
export const validateThreeMfStructure = (bytes: Uint8Array<ArrayBuffer>): Record<string, number> => {
  const archive = unzipSync(bytes);
  const contentTypes = archive['[Content_Types].xml'];
  const relationships = archive['_rels/.rels'];
  assert.ok(contentTypes && relationships, '3MF archive is missing its package manifests');
  const modelPaths = Object.keys(archive).filter((name) => name.toLowerCase().endsWith('.model'));
  assert.ok(modelPaths.length > 0, '3MF archive contains no model');
  let declaredModel = false;
  parseXml(contentTypes, (tag) => {
    declaredModel ||= Object.values(tag.attributes).some((value) => value.includes('3dmanufacturing-3dmodel'));
  });
  assert.ok(declaredModel, '3MF package does not declare a model content type');
  const linkedModels: string[] = [];
  parseXml(relationships, (tag) => {
    const target = tag.attributes['Target']?.replace(/^\//u, '');
    if (localName(tag.name) === 'Relationship' && target !== undefined && modelPaths.includes(target)) {
      linkedModels.push(target);
    }
  });
  assert.ok(linkedModels.length > 0, '3MF package does not link its model');
  const counts: Record<string, number> = {
    models: modelPaths.length,
    objects: 0,
    meshes: 0,
    vertices: 0,
    triangles: 0,
    buildItems: 0,
  };
  const models = new Map<string, ModelStructure>();
  for (const modelPath of modelPaths) {
    const model = archive[modelPath];
    assert.ok(model);
    const structure = checkModelXml(model);
    models.set(modelPath, structure);
    for (const [name, count] of Object.entries(structure.counts)) {
      counts[name] = (counts[name] ?? 0) + count;
    }
  }
  assert.ok((counts['meshes'] ?? 0) > 0, '3MF package has no triangle mesh');
  assert.ok(
    linkedModels.some((modelPath) => (models.get(modelPath)?.counts['buildItems'] ?? 0) > 0),
    '3MF linked model has no build items',
  );
  checkBuildGeometry(models, linkedModels);
  return counts;
};

/** Validate STEP physical-file sections and geometric entity structure, without claiming BRep validity. */
export const validateStepStructure = (bytes: Uint8Array<ArrayBuffer>): Record<string, number> => {
  // STEP strings and comments can contain arbitrary entity-like text; they are never geometry records.
  const text = decoder
    .decode(bytes)
    .replaceAll(/'(?:''|[^'])*'|\/\*[\s\S]*?\*\//gu, ' ')
    .trim();
  assert.ok(
    !text.includes("'") && !text.includes('/*') && !text.includes('*/'),
    'STEP contains an unterminated string or comment',
  );
  assert.ok(
    text.startsWith('ISO-10303-21;') && text.endsWith('END-ISO-10303-21;'),
    'STEP physical-file markers are missing',
  );
  const header = /\bHEADER\s*;([\s\S]*?)\bENDSEC\s*;/iu.exec(text)?.[1];
  const blocks = [...text.matchAll(/\bDATA(?:\s*\([^)]*\))?\s*;([\s\S]*?)\bENDSEC\s*;/giu)].map(
    (match) => match[1] ?? '',
  );
  assert.ok(
    header !== undefined && /\bFILE_SCHEMA\s*\(/iu.test(header) && blocks.length > 0,
    'STEP header, schema or data section is missing',
  );
  const entityPattern = /#(\d+)\s*=\s*([^;]+);/gu;
  const records = blocks.flatMap((block) => {
    const records = [...block.matchAll(entityPattern)];
    assert.equal(block.replaceAll(entityPattern, '').trim(), '', 'STEP DATA contains incomplete entity records');
    return records;
  });
  const entities = records.map((match) => integer(match[1], 'STEP entity ID', 1));
  assert.ok(
    entities.length > 0 && new Set(entities).size === entities.length,
    'STEP entity IDs are empty or duplicated',
  );
  const data = records.map((record) => record[2]).join('\n');
  const points = [...data.matchAll(/\bCARTESIAN_POINT\s*\(/giu)].length;
  const surfaces = [...data.matchAll(/\b(?:ADVANCED_FACE|FACE_SURFACE|POLY_LOOP|TRIANGULATED_FACE_SET)\s*\(/giu)]
    .length;
  assert.ok(points > 0 && surfaces > 0, 'STEP file has no geometric surface entities');
  return { entities: entities.length, points, surfaces };
};

const checkFaceIndices = (values: readonly string[], available: readonly number[], maximum: number[]): void => {
  assert.ok(values.length >= 3, 'OBJ face has fewer than three vertices');
  for (const value of values) {
    const indices = value.split('/');
    assert.ok(indices.length <= 3 && indices[0] !== '', 'OBJ face has an invalid vertex reference');
    for (const [axis, token] of indices.entries()) {
      if (token === '') {
        continue;
      }
      const index = Number(token);
      assert.ok(Number.isSafeInteger(index) && index !== 0, 'OBJ face index is not a nonzero integer');
      assert.ok(index > 0 || -index <= (available[axis] ?? 0), 'OBJ negative face index references a missing vertex');
      maximum[axis] = Math.max(maximum[axis] ?? 0, index);
    }
  }
};

/** Validate OBJ vertex records and positive/negative face indices without claiming surface topology. */
export const validateWavefrontStructure = (bytes: Uint8Array<ArrayBuffer>): Record<string, number> => {
  const text = decoder.decode(bytes).replaceAll(/\\\r?\n/gu, '');
  const counts = { vertices: 0, textures: 0, normals: 0, faces: 0 };
  const maximum = [0, 0, 0];
  for (const line of text.split(/\r?\n/u)) {
    const [kind, ...values] = line.replace(/#.*$/u, '').trim().split(/\s+/u);
    if (kind === 'v' || kind === 'vn' || kind === 'vt') {
      const required = kind === 'vt' ? 1 : 3;
      assert.ok(
        values.length >= required && values.every((value) => Number.isFinite(Number(value))),
        `OBJ ${kind} has invalid coordinates`,
      );
      if (kind === 'v') {
        counts.vertices += 1;
      } else if (kind === 'vn') {
        counts.normals += 1;
      } else {
        counts.textures += 1;
      }
    } else if (kind === 'f') {
      checkFaceIndices(values, [counts.vertices, counts.textures, counts.normals], maximum);
      counts.faces += 1;
    }
  }
  assert.ok(counts.vertices > 0 && counts.faces > 0, 'OBJ has no nonempty face geometry');
  for (const [axis, available] of [counts.vertices, counts.textures, counts.normals].entries()) {
    assert.ok((maximum[axis] ?? 0) <= available, 'OBJ face index references a missing vertex');
  }
  return counts;
};
