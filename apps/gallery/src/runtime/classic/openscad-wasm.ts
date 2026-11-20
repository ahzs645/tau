import type { OpenSCAD } from 'openscad-wasm-prebuilt';

declare module 'openscad-wasm-prebuilt' {
  /* eslint-disable @typescript-eslint/naming-convention -- Declaration merging requires the vendor's FS interface name. */
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Module augmentation must merge with the vendor interface.
  interface FS {
    /** Standard Emscripten FS API, present in the pinned build but omitted from its declarations. */
    chdir(path: string): void;
  }
  /* eslint-enable @typescript-eslint/naming-convention -- Resume naming checks after the vendor FS augmentation. */
  /* eslint-disable @typescript-eslint/naming-convention -- Declaration merging requires the vendor's OpenSCAD interface name. */
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Module augmentation must merge with the vendor interface.
  interface OpenSCAD {
    /** Emscripten environment values consumed by fontconfig and OpenSCAD's include search. */
    ENV?: Record<string, string>;
  }
  /* eslint-enable @typescript-eslint/naming-convention -- Resume naming checks after the vendor OpenSCAD augmentation. */
}

export type ClassicOpenScadInstance = OpenSCAD;
