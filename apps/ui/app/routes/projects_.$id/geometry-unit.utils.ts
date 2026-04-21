/**
 * Sort geometry unit entries so that the main entry file appears first,
 * with remaining entries sorted alphabetically.
 */
export const sortGeometryUnitEntries = <T>(entries: Array<[string, T]>, mainEntryFile: string): Array<[string, T]> =>
  [...entries].sort(([a], [b]) => {
    if (a === mainEntryFile) {
      return -1;
    }
    if (b === mainEntryFile) {
      return 1;
    }
    return a.localeCompare(b);
  });
