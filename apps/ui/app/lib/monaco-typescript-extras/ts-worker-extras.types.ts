/**
 * TS language-service worker methods used by Tau adapters but omitted from
 * `monaco.d.ts` `TypeScriptWorker`.
 */
export type TauTypeScriptLanguageServiceWorker = {
  getDefinitionAtPosition(fileName: string, position: number): Promise<readonly unknown[] | undefined>;
  getReferencesAtPosition(fileName: string, position: number): Promise<readonly unknown[] | undefined>;
  getRenameInfo(fileName: string, position: number, options: unknown): Promise<unknown>;
  findRenameLocations(
    fileName: string,
    position: number,
    findInStrings: boolean,
    findInComments: boolean,
    providePrefixAndSuffixTextForRename: boolean,
  ): Promise<readonly unknown[] | undefined>;
  getLibFiles(): Promise<Record<string, string>>;
  getImplementationAtPosition(fileName: string, position: number): Promise<readonly unknown[] | undefined>;
  getTypeDefinitionAtPosition(fileName: string, position: number): Promise<readonly unknown[] | undefined>;
  getNavigateToItems(
    searchValue: string,
    maxResultCount?: number,
    fileName?: string,
    excludeDtsFiles?: boolean,
    excludeLibFiles?: boolean,
  ): Promise<readonly unknown[] | undefined>;
  prepareCallHierarchy(fileName: string, position: number): Promise<unknown>;
  provideCallHierarchyIncomingCalls(fileName: string, position: number): Promise<readonly unknown[] | undefined>;
  provideCallHierarchyOutgoingCalls(fileName: string, position: number): Promise<readonly unknown[] | undefined>;
};

export type TsDefinitionLike = Readonly<{
  fileName: string;
  textSpan: { start: number; length: number };
}>;
