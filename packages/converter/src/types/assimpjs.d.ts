/* oxlint-disable no-barrel-files/no-barrel-files -- allowed for this type declaration file */
/* eslint-disable @typescript-eslint/naming-convention -- External library uses PascalCase method names */

// Base module with all type definitions
declare module 'assimpjs' {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-imports -- Required to keep module as ambient type definition
  type EmscriptenModuleConfig = import('#types/emscripten.d.ts').EmscriptenModuleConfig;

  /**
   * Result object from Assimp conversion with file access and success status.
   */
  export type AssimpResult = {
    IsSuccess(): boolean;
    FileCount(): number;
    GetFile(index: number): AssimpFile;
    GetErrorCode(): string;
  };

  /**
   * Represents a single exported file from Assimp conversion.
   */
  export type AssimpFile = {
    GetContent(): Uint8Array<ArrayBuffer>;
    GetPath(): string;
  };

  /**
   * Container for input files passed to Assimp conversion.
   */
  export type FileList = {
    AddFile(name: string, content: Uint8Array<ArrayBuffer>): void;
  };

  /**
   * Main Assimp.wasm module interface for format conversion.
   */
  export type AssimpJS = {
    FileList: new () => FileList;
    ConvertFileList(fileList: FileList, format: string): AssimpResult;
    ConvertFile(
      name: string,
      format: string,
      content: Uint8Array<ArrayBuffer>,
      existsFunction: (filename: string) => boolean,
      loadFunction: (filename: string) => Uint8Array<ArrayBuffer>,
    ): AssimpResult;
  };

  function assimpjs(config?: EmscriptenModuleConfig): Promise<AssimpJS>;
  export default assimpjs;
}

// Re-export everything from the base module
declare module 'assimpjs/all' {
  export * from 'assimpjs';
  export { default } from 'assimpjs';
}

// Re-export everything from the base module
declare module 'assimpjs/exporter' {
  export * from 'assimpjs';
  export { default } from 'assimpjs';
}
