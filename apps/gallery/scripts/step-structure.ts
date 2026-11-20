import assert from 'node:assert/strict';
import { createStepEntityIds } from '#scripts/step-entity-ids.js';
import { createStepLexer } from '#scripts/step-lexer.js';
import type { StepToken } from '#scripts/step-lexer.js';

const maximumChunkBytes = 64 * 1024;
const surfaceNames = new Set(['ADVANCED_FACE', 'FACE_SURFACE', 'POLY_LOOP', 'TRIANGULATED_FACE_SET']);
const markersMissing = 'STEP physical-file markers are missing';
const sectionsMissing = 'STEP header, schema or data section is missing';
const incompleteRecords = 'STEP DATA contains incomplete entity records';

type StepSection = 'outside' | 'header' | 'data';
const isSymbol = (token: StepToken | undefined, value: string): boolean =>
  token?.kind === 'symbol' && token.value === value;

/**
 * Validate physical-file sections and actual geometric entity records from bounded byte chunks.
 * This is a structural check, not STEP semantic or BRep validation. Text memory is bounded independently
 * of file and record length; exact ID uniqueness uses sparse pages and compact dense bitmaps.
 * @internal
 */
export const validateStepChunks = (chunks: Iterable<Uint8Array<ArrayBuffer>>): Record<string, number> => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const ids = createStepEntityIds();
  const counts = { entities: 0, points: 0, surfaces: 0 };
  let section: StepSection = 'outside';
  let started = false;
  let ended = false;
  let headerSeen = false;
  let schemaSeen = false;
  let dataSeen = false;
  let first: StepToken | undefined;
  let second: StepToken | undefined;
  let last: StepToken | undefined;
  let tokens = 0;
  let points = 0;
  let surfaces = 0;
  let schemas = 0;
  let dataDepth = 0;
  let dataEnd = 0;

  const outsideRecord = (name: string | undefined, terminator: StepToken): void => {
    if (name === 'END-ISO-10303-21') {
      assert.ok(tokens === 1 && !terminator.separated, markersMissing);
      ended = true;
    } else if (name?.toUpperCase() === 'HEADER' && tokens === 1) {
      section = 'header';
    } else if (name?.toUpperCase() === 'DATA') {
      assert.ok(
        tokens === 1 || (isSymbol(second, '(') && isSymbol(last, ')') && dataDepth === 0 && dataEnd === tokens),
        sectionsMissing,
      );
      section = 'data';
      dataSeen = true;
    }
  };

  const finishRecord = (terminator: StepToken): void => {
    const name = first?.kind === 'word' ? first.value : undefined;
    assert.ok(!ended, markersMissing);
    if (!started) {
      assert.ok(name === 'ISO-10303-21' && tokens === 1 && !terminator.separated, markersMissing);
      started = true;
    } else if (section === 'outside') {
      outsideRecord(name, terminator);
    } else if (name?.toUpperCase() === 'ENDSEC' && tokens === 1) {
      headerSeen ||= section === 'header';
      section = 'outside';
    } else if (section === 'header') {
      schemaSeen ||= schemas > 0;
    } else {
      assert.ok(first?.kind === 'id' && isSymbol(second, '=') && tokens >= 3, incompleteRecords);
      ids.add(first.value);
      counts.entities += 1;
      counts.points += points;
      counts.surfaces += surfaces;
    }
    first = undefined;
    second = undefined;
    last = undefined;
    tokens = 0;
    points = 0;
    surfaces = 0;
    schemas = 0;
    dataDepth = 0;
    dataEnd = 0;
  };

  const summarize = (): Record<string, number> => {
    assert.ok(started && ended && tokens === 0, markersMissing);
    assert.ok(section === 'outside' && headerSeen && schemaSeen && dataSeen, sectionsMissing);
    assert.ok(counts.entities > 0, 'STEP entity IDs are empty or duplicated');
    assert.ok(counts.points > 0 && counts.surfaces > 0, 'STEP file has no geometric surface entities');
    return counts;
  };

  const lexer = createStepLexer((token) => {
    if (isSymbol(token, ';')) {
      finishRecord(token);
      return;
    }
    if (isSymbol(token, '(') && last?.kind === 'word') {
      const name = last.value?.toUpperCase();
      points += name === 'CARTESIAN_POINT' ? 1 : 0;
      surfaces += name !== undefined && surfaceNames.has(name) ? 1 : 0;
      schemas += name === 'FILE_SCHEMA' ? 1 : 0;
    }
    if (tokens === 0) {
      first = token;
    } else if (tokens === 1) {
      second = token;
    }
    tokens += 1;
    if (first?.kind === 'word' && first.value?.toUpperCase() === 'DATA') {
      if (isSymbol(token, '(')) {
        dataDepth += 1;
      } else if (isSymbol(token, ')')) {
        dataDepth -= 1;
        if (dataDepth === 0 && dataEnd === 0) {
          dataEnd = tokens;
        }
      }
    }
    last = token;
  });
  for (const bytes of chunks) {
    for (let offset = 0; offset < bytes.byteLength; offset += maximumChunkBytes) {
      lexer.write(decoder.decode(bytes.subarray(offset, offset + maximumChunkBytes), { stream: true }));
    }
  }
  lexer.write(decoder.decode());
  lexer.finish();
  return summarize();
};
