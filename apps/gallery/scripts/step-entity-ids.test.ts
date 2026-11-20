import { AssertionError } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { createStepEntityIds } from '#scripts/step-entity-ids.js';

describe('STEP entity ID uniqueness', () => {
  it('should retain more than V8’s Set limit of out-of-order IDs and still reject exact duplicates', () => {
    const ids = createStepEntityIds();
    // Keep #1 absent until the end, as native exporters may do. A prefix plus one Set cannot
    // represent this valid stream. The compact membership pages need about 2 MiB for its IDs.
    const maximum = 2 ** 24 + 2;
    for (let id = maximum; id >= 2; id -= 1) {
      ids.add(id);
    }
    ids.add(1);
    for (const duplicate of [1, 2, 31, 32, 4095, 4096, maximum - 1, maximum]) {
      expect(() => {
        ids.add(duplicate);
      }).toThrow('STEP entity IDs are empty or duplicated');
      expect(() => {
        ids.add(duplicate);
      }).toThrow(AssertionError);
    }
  });

  it('should distinguish sparse safe integers across bitmap, page and 32-bit partition boundaries', () => {
    const ids = createStepEntityIds();
    const values = [
      1,
      31,
      32,
      33,
      4095,
      4096,
      4097,
      2 ** 31 - 1,
      2 ** 31,
      2 ** 32 - 1,
      2 ** 32,
      2 ** 32 + 1,
      2 ** 52 - 1,
      2 ** 52,
      2 ** 52 + 1,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const id of values.toReversed()) {
      ids.add(id);
    }
    for (const id of values) {
      expect(() => {
        ids.add(id);
      }).toThrow('STEP entity IDs are empty or duplicated');
    }
  });

  it('should preserve sparse members when a page becomes dense, including the signed bitmap bit', () => {
    const ids = createStepEntityIds();
    const values = [31, 4095, 32, 1, ...Array.from({ length: 100 }, (_, index) => (index + 1) * 33)];
    for (const id of values) {
      ids.add(id);
    }
    for (const id of values.toReversed()) {
      expect(() => {
        ids.add(id);
      }).toThrow('STEP entity IDs are empty or duplicated');
    }
    ids.add(4096 + 31);
    expect(() => {
      ids.add(4096 + 31);
    }).toThrow('STEP entity IDs are empty or duplicated');
  });

  it('should match an independent membership oracle for interleaved sparse and dense IDs', () => {
    const ids = createStepEntityIds();
    const expected = new Set<number>();
    for (let index = 0; index < 20_000; index += 1) {
      // Interleave two separated partitions, repeating each local number in a different order.
      const localId = ((index * 8191) % 9973) + 1;
      const id = localId + (index % 2 === 0 ? 0 : 2 ** 48);
      if (expected.has(id)) {
        expect(() => {
          ids.add(id);
        }).toThrow('STEP entity IDs are empty or duplicated');
      } else {
        ids.add(id);
        expected.add(id);
      }
    }
    for (const id of expected) {
      expect(() => {
        ids.add(id);
      }).toThrow(AssertionError);
    }
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'should reject invalid entity ID %s without changing membership',
    (id) => {
      const ids = createStepEntityIds();
      expect(() => {
        ids.add(id);
      }).toThrow('STEP entity ID must be an integer ≥ 1');
      expect(() => {
        ids.add(id);
      }).toThrow(AssertionError);
      ids.add(1);
      expect(() => {
        ids.add(1);
      }).toThrow('STEP entity IDs are empty or duplicated');
    },
  );
});
