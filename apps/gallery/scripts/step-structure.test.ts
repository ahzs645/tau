import { describe, expect, it, vi } from 'vitest';
import { validateStepChunks } from '#scripts/step-structure.js';
import { validateStepStructure } from '#scripts/export-structure.js';
import { triangleStepFixture } from '#scripts/export-artifacts.fixture.js';

const encoder = new TextEncoder();
const source = new TextDecoder().decode(triangleStepFixture);
const expected = { entities: 4, points: 3, surfaces: 1 };
const chunksOf = function* (bytes: Uint8Array<ArrayBuffer>, width: number): Generator<Uint8Array<ArrayBuffer>> {
  for (let offset = 0; offset < bytes.byteLength; offset += width) {
    yield bytes.subarray(offset, offset + width);
  }
};
const withData = (data: string): string => source.replace(/DATA;[\s\S]*?ENDSEC;/u, `DATA;${data}ENDSEC;`);

describe('streamed STEP structural validation', () => {
  it('should retain the result at every byte boundary, including escaped quotes, comments and UTF-8', () => {
    const text = source
      .replace('Structural validation fixture', "Reader''s café 😀; /* not a comment */ CARTESIAN_POINT(1,2,3)")
      .replace('DATA;', "DATA('one');/* #99=POLY_LOOP(1,2,3); 'not a string' */")
      .replace('#4=', "#5=DESCRIPTIVE_REPRESENTATION_ITEM('FACE_SURFACE(''x''); #1=whatever;','notes');\n#4=");
    const bytes = encoder.encode(text);
    const counts = { ...expected, entities: 5 };
    for (let split = 0; split <= bytes.byteLength; split += 1) {
      expect(validateStepChunks([bytes.subarray(0, split), bytes.subarray(split)]), `split ${split}`).toEqual(counts);
    }
    expect(validateStepChunks(chunksOf(bytes, 1))).toEqual(counts);
  });

  it('should keep exact ID uniqueness across contiguous, sparse, out-of-order and multiple DATA sections', () => {
    const data = `
#3=CARTESIAN_POINT('',(0.,0.,0.));
#0001=CARTESIAN_POINT('',(1.,0.,0.));
#2=CARTESIAN_POINT('',(0.,2.,0.));
ENDSEC;DATA('two');
#9007199254740991=POLY_LOOP('',(#1,#2,#3));`;
    expect(validateStepChunks(chunksOf(encoder.encode(withData(data)), 7))).toEqual(expected);
    for (const duplicate of ['#1=POLY_LOOP(1,2,3);', '#3=POLY_LOOP(1,2,3);', '#9007199254740991=POLY_LOOP(1,2,3);']) {
      expect(() => validateStepChunks(chunksOf(encoder.encode(withData(data + duplicate)), 3))).toThrow(
        'entity IDs are empty or duplicated',
      );
    }
    const pendingDuplicate = withData('#5=CARTESIAN_POINT(0,0,0);#5=POLY_LOOP(1,2,3);');
    expect(() => validateStepStructure(encoder.encode(pendingDuplicate))).toThrow('entity IDs are empty or duplicated');
  });

  it('should accept long leading-zero IDs without retaining the numeric token as a string', () => {
    const text = source.replace('#1=', `#${'0'.repeat(100_000)}1=`);
    expect(validateStepChunks(chunksOf(encoder.encode(text), 97))).toEqual(expected);
  });

  it.each([
    { text: source.replace('ISO-10303-21;', 'ISO-10303-20;'), error: 'physical-file markers' },
    { text: source.replace('END-ISO-10303-21;', ''), error: 'physical-file markers' },
    { text: `${source}garbage;`, error: 'physical-file markers' },
    { text: source.replace('HEADER;', ''), error: 'header, schema or data' },
    { text: source.replace('FILE_SCHEMA', 'DESCRIPTION'), error: 'header, schema or data' },
    { text: source.replace('DATA;', 'NOT_DATA;'), error: 'header, schema or data' },
    { text: source.replace('DATA;', 'DATA() WRONG();'), error: 'header, schema or data' },
    { text: source.replace('DATA;', 'DATA()();'), error: 'header, schema or data' },
    { text: source.replace('DATA;', 'DATA((x);'), error: 'header, schema or data' },
    { text: withData('#1=;'), error: 'incomplete entity records' },
    { text: withData('#1=CARTESIAN_POINT(1,2,3)'), error: 'incomplete entity records' },
    { text: withData('not_an_entity;'), error: 'incomplete entity records' },
    { text: withData('#0=CARTESIAN_POINT(1,2,3);'), error: 'integer ≥ 1' },
    { text: withData('#9007199254740992=CARTESIAN_POINT(1,2,3);'), error: 'integer ≥ 1' },
    { text: `${source}/* unclosed`, error: 'unterminated string or comment' },
    { text: `${source}'unclosed`, error: 'unterminated string or comment' },
    { text: `${source}'escaped''`, error: 'unterminated string or comment' },
    { text: `${source}*/`, error: 'unterminated string or comment' },
  ])('should reject malformed STEP structure: $error ($text)', ({ text, error }) => {
    expect(() => validateStepChunks(chunksOf(encoder.encode(text), 1))).toThrow(error);
  });

  it('should never count geometry-like names in strings, comments or the middle of longer identifiers', () => {
    const text = withData(`
#1=DESCRIPTIVE_REPRESENTATION_ITEM('CARTESIAN_POINT(''x'') FACE_SURFACE(1,2,3)','');
#2=${'X'.repeat(100_000)}CARTESIAN_POINT(1,2,3);
/* #9=CARTESIAN_POINT(0,0,0); #10=POLY_LOOP(1,2,3); */
#3=CAR/* split keyword */TESIAN_POINT(1,2,3);`);
    expect(() => validateStepChunks(chunksOf(encoder.encode(text), 31))).toThrow('no geometric surface entities');
  });

  it('should honor exact byte views and reject malformed or truncated UTF-8', () => {
    const framed = encoder.encode(`outside${source}outside`);
    expect(validateStepStructure(framed.subarray(7, framed.byteLength - 7))).toEqual(expected);
    expect(() => validateStepChunks([triangleStepFixture, new Uint8Array([0xc3])])).toThrow(/encoding|encoded data/iu);
    expect(() => validateStepChunks([triangleStepFixture, new Uint8Array([0xc3, 0x28])])).toThrow(
      /encoding|encoded data/iu,
    );
  });

  it('should cap each decode even when the public API receives one larger byte array', () => {
    const bytes = encoder.encode(source.replace('DATA;', `/*${'x'.repeat(256 * 1024)}*/DATA;`));
    const original = TextDecoder.prototype.decode;
    let maximum = 0;
    const decoding = vi
      .spyOn(TextDecoder.prototype, 'decode')
      .mockImplementation(function (this: TextDecoder, input, options) {
        const length = input?.byteLength ?? 0;
        maximum = Math.max(maximum, length);
        if (length > 64 * 1024) {
          throw new RangeError('Monolithic STEP decode exceeds the bounded input size.');
        }
        return original.call(this, input, options);
      });
    try {
      expect(validateStepStructure(bytes)).toEqual(expected);
      expect(maximum).toBe(64 * 1024);
    } finally {
      decoding.mockRestore();
    }
  });

  it('should validate a logical STEP file beyond V8’s string limit with only a reused one-megabyte chunk', () => {
    const repeated = encoder.encode('x'.repeat(1024 * 1024));
    const repetitions = 513;
    const prefix = encoder.encode('ISO-10303-21;/*');
    const suffix = encoder.encode(`*/${source.slice('ISO-10303-21;'.length)}`);
    const logicalBytes = prefix.byteLength + repeated.byteLength * repetitions + suffix.byteLength;
    expect(logicalBytes).toBeGreaterThan(0x1f_ff_ff_e8);
    const chunks = function* (): Generator<Uint8Array<ArrayBuffer>> {
      yield prefix;
      for (let index = 0; index < repetitions; index += 1) {
        yield repeated;
      }
      yield suffix;
    };
    expect(validateStepChunks(chunks())).toEqual(expected);
  });

  it('should summarize a dense native-style entity stream without keeping a record array', () => {
    const records = 100_000;
    const chunks = function* (): Generator<Uint8Array<ArrayBuffer>> {
      yield encoder.encode("ISO-10303-21;HEADER;FILE_SCHEMA(('AP214'));ENDSEC;DATA;");
      for (let index = 1; index <= records; index += 1) {
        yield encoder.encode(`#${index}=CARTESIAN_POINT('',(1.,2.,3.));\n`);
      }
      yield encoder.encode(`#${records + 1}=POLY_LOOP('',(#1,#2,#3));ENDSEC;END-ISO-10303-21;`);
    };
    expect(validateStepChunks(chunks())).toEqual({ entities: records + 1, points: records, surfaces: 1 });
  });
});
