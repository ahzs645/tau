/* eslint-disable @typescript-eslint/naming-convention -- some formats are named like this */
/* eslint-disable new-cap -- External library uses PascalCase method names */
import assimpjs from 'assimpjs/all';
import type { FileExtension, FileInput } from '@taucad/types';
import { applyGlbTransforms } from '#gltf.transforms.js';
import { BaseLoader } from '#loaders/base.loader.js';

type AssimpOptions = {
  format: FileExtension;
};

/**
 *
 */
export class AssimpLoader extends BaseLoader<Uint8Array<ArrayBuffer>, AssimpOptions> {
  private static readonly transformYtoZupRequired: Partial<Record<FileExtension, boolean>> = {
    dxf: true,
    x: true,
    dae: true,
    '3ds': true,
    fbx: true,
    usda: true,
    usdz: true,
    ifc: true,
    x3d: true,
    obj: true,
    lwo: true,
    ase: true,
  };

  protected async parseAsync(files: FileInput[], options: AssimpOptions): Promise<Uint8Array<ArrayBuffer>> {
    const ajs = await assimpjs({
      locateFile() {
        const wasmPath = new URL('../assets/assimpjs/assimpjs-all.wasm', import.meta.url).href;

        return wasmPath;
      },
    });

    const fileList = new ajs.FileList();

    for (const file of files) {
      fileList.AddFile(file.name, file.bytes);
    }

    const result = ajs.ConvertFileList(fileList, 'glb2');

    if (!result.IsSuccess() || result.FileCount() === 0) {
      throw new Error(`Failed to convert ${options.format} file: ${result.GetErrorCode()}`);
    }

    const resultFile = result.GetFile(0);

    // GetContent() returns a typed_memory_view — a live view into WASM linear
    // memory.  We must copy it to an independent buffer immediately: the view
    // is invalidated the moment the WebAssembly.Memory grows (any later
    // malloc/free in the same module detaches the underlying ArrayBuffer).
    const glbData = new Uint8Array(resultFile.GetContent());

    const transformYtoZup = AssimpLoader.transformYtoZupRequired[options.format] ?? false;

    if (transformYtoZup) {
      return applyGlbTransforms(glbData, {
        transformYtoZup,
        scaleMetersToMillimeters: false,
      });
    }

    return glbData;
  }

  protected mapToGlb(parseResult: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    return parseResult;
  }
}
