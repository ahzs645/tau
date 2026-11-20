import { unzipSync } from 'fflate';
import type { Unzipped } from 'fflate';
import { SaxesParser } from 'saxes';
import type { SaxesTagNS } from 'saxes';

export type ThreeMfPoint = readonly [number, number, number];
export type ThreeMfFace = { indices: ThreeMfPoint; material: number; palette: number };
export type ThreeMfObject = {
  id: number;
  name: string;
  type: string;
  vertices: ThreeMfPoint[];
  triangles: ThreeMfFace[];
};
export type ParsedThreeMf = {
  entries: string[];
  namespace: string;
  unit: string;
  paletteId: number;
  colors: string[];
  objects: ThreeMfObject[];
  build: number[];
  modelTarget: string;
  modelRelationship: string;
  contentTypes: Record<string, string>;
};

const attribute = (tag: SaxesTagNS, name: string): string => {
  const value = tag.attributes[name]?.value;
  if (value === undefined) {
    throw new Error(`Missing ${name} on ${tag.name}`);
  }
  return value;
};

const numberAttribute = (tag: SaxesTagNS, name: string): number => {
  const value = Number(attribute(tag, name));
  if (!Number.isFinite(value)) {
    throw new TypeError(`Nonfinite ${name} on ${tag.name}`);
  }
  return value;
};

const visitXml = (bytes: Unzipped[string] | undefined, visit: (tag: SaxesTagNS) => void): void => {
  if (!bytes) {
    throw new Error('Missing XML part.');
  }
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', visit);
  parser.on('error', (error) => {
    throw error;
  });
  parser.write(new TextDecoder().decode(bytes)).close();
};

/** Independent XML reader for serializer assertions; it does not call production geometry validation. */
export const readThreeMfFixture = (bytes: Uint8Array<ArrayBuffer>): ParsedThreeMf => {
  const files = unzipSync(bytes);
  const result: ParsedThreeMf = {
    entries: Object.keys(files),
    namespace: '',
    unit: '',
    paletteId: 0,
    colors: [],
    objects: [],
    build: [],
    modelTarget: '',
    modelRelationship: '',
    contentTypes: {},
  };
  visitXml(files['_rels/.rels'], (tag) => {
    if (tag.local === 'Relationship') {
      result.modelTarget = attribute(tag, 'Target');
      result.modelRelationship = attribute(tag, 'Type');
    }
  });
  visitXml(files['[Content_Types].xml'], (tag) => {
    if (tag.local === 'Default') {
      result.contentTypes[attribute(tag, 'Extension')] = attribute(tag, 'ContentType');
    }
  });
  let current: ThreeMfObject | undefined;
  visitXml(files[result.modelTarget.replace(/^\//u, '')], (tag) => {
    switch (tag.local) {
      case 'model': {
        result.namespace = tag.uri;
        result.unit = attribute(tag, 'unit');
        break;
      }
      case 'basematerials': {
        result.paletteId = numberAttribute(tag, 'id');
        break;
      }
      case 'base': {
        result.colors.push(attribute(tag, 'displaycolor'));
        break;
      }
      case 'object': {
        current = {
          id: numberAttribute(tag, 'id'),
          name: attribute(tag, 'name'),
          type: attribute(tag, 'type'),
          vertices: [],
          triangles: [],
        };
        result.objects.push(current);
        break;
      }
      case 'vertex': {
        if (!current) {
          throw new Error('Vertex without object.');
        }
        current.vertices.push([numberAttribute(tag, 'x'), numberAttribute(tag, 'y'), numberAttribute(tag, 'z')]);
        break;
      }
      case 'triangle': {
        if (!current) {
          throw new Error('Triangle without object.');
        }
        current.triangles.push({
          indices: [numberAttribute(tag, 'v1'), numberAttribute(tag, 'v2'), numberAttribute(tag, 'v3')],
          material: numberAttribute(tag, 'p1'),
          palette: numberAttribute(tag, 'pid'),
        });
        break;
      }
      case 'item': {
        result.build.push(numberAttribute(tag, 'objectid'));
        break;
      }
      default: {
        break;
      }
    }
  });
  return result;
};
