import type { OpenSCAD } from 'openscad-wasm-prebuilt';

declare module 'openscad-wasm-prebuilt' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Module augmentation must merge with the vendor interface.
  interface FS {
    /** Standard Emscripten FS API, present in the pinned build but omitted from its declarations. */
    chdir(path: string): void;
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Module augmentation must merge with the vendor interface.
  interface OpenSCAD {
    /** Emscripten environment values consumed by fontconfig and OpenSCAD's include search. */
    ENV?: Record<string, string>;
  }
}

export type ClassicOpenScadInstance = OpenSCAD;
