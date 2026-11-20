import assert from 'node:assert/strict';

const partitionWidth = 2 ** 32;
const pageWidth = 4096;
const sparsePageLimit = 32;
type EntityPage = Set<number> | Uint32Array<ArrayBuffer>;

/** Claim one exact bit, returning false if this ID was already present. */
const claimBit = (page: Uint32Array<ArrayBuffer>, offset: number): boolean => {
  const index = Math.floor(offset / 32);
  /* oxlint-disable no-bitwise -- Each bitmap word stores exactly 32 independent entity-presence flags. */
  const mask = 1 << (offset % 32);
  const word = page[index]!;
  if ((word & mask) !== 0) {
    return false;
  }
  page[index] = word | mask;
  /* oxlint-enable no-bitwise */
  return true;
};

/**
 * Track exact STEP entity IDs without a collection entry per dense entity or an allocation up to
 * the largest ID. Sparse pages promote to 512-byte bitmaps after 32 IDs. The two map levels split
 * safe integers into at most 2^21 partitions and 2^20 pages each; no individual map or set can
 * approach V8's 2^24-entry limit, even when IDs are sparse, unordered, or omit the lowest numbers.
 * @internal
 */
export const createStepEntityIds = (): { add(id: number): void } => {
  const partitions = new Map<number, Map<number, EntityPage>>();
  return {
    add(id: number): void {
      assert.ok(Number.isSafeInteger(id) && id >= 1, 'STEP entity ID must be an integer ≥ 1');
      const partitionIndex = Math.floor(id / partitionWidth);
      let pages = partitions.get(partitionIndex);
      if (!pages) {
        pages = new Map();
        partitions.set(partitionIndex, pages);
      }
      const localId = id % partitionWidth;
      const pageIndex = Math.floor(localId / pageWidth);
      const offset = localId % pageWidth;
      let page = pages.get(pageIndex);
      if (!page) {
        page = new Set();
        pages.set(pageIndex, page);
      }
      if (page instanceof Set) {
        assert.ok(!page.has(offset), 'STEP entity IDs are empty or duplicated');
        page.add(offset);
        if (page.size === sparsePageLimit) {
          const bitmap = new Uint32Array(pageWidth / 32);
          for (const previous of page) {
            claimBit(bitmap, previous);
          }
          pages.set(pageIndex, bitmap);
        }
      } else {
        assert.ok(claimBit(page, offset), 'STEP entity IDs are empty or duplicated');
      }
    },
  };
};
