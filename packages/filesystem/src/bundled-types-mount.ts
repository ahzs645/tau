import type { WorkspaceFileService } from '#workspace-file-service.js';

/**
 * One kernel typings entry mirrored under `/node_modules/<packageName>/` in the worker.
 *
 * @public
 */
export type BundledTypesMountEntry = Readonly<{
  packageName: string;
  content: string;
  /** When true, `content` is emitted verbatim (already `declare module` or ambient). */
  prewrapped?: boolean;
}>;

/**
 * Payload posted from the main thread after the FM worker mounts `/node_modules`.
 *
 * @public
 */
export type BundledTypesPayload = readonly BundledTypesMountEntry[];

function declarationSource(entry: BundledTypesMountEntry): string {
  return entry.prewrapped ? entry.content : `declare module '${entry.packageName}' {\n${entry.content}\n}`;
}

function bytesEqual(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }

  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

async function readFileBytes(
  service: WorkspaceFileService,
  path: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  try {
    const data = await service.readFile(path);
    if (typeof data === 'string') {
      return new TextEncoder().encode(data);
    }

    return data;
  } catch {
    return undefined;
  }
}

/**
 * Writes bundled `.d.ts` + minimal `package.json` under `/node_modules/<pkg>/`.
 * Skips writes when existing bytes match (idempotent across reloads).
 *
 * @public
 */
export async function populateBundledTypesMount(
  fileService: WorkspaceFileService,
  payload: BundledTypesPayload,
): Promise<void> {
  for (const entry of payload) {
    const dtsPath = `/node_modules/${entry.packageName}/index.d.ts`;
    const pkgPath = `/node_modules/${entry.packageName}/package.json`;
    const source = declarationSource(entry);
    const expectedDts = new TextEncoder().encode(source);
    const pkgJson = JSON.stringify({ name: entry.packageName, types: 'index.d.ts' });
    const expectedPkg = new TextEncoder().encode(pkgJson);

    const existingDts = await readFileBytes(fileService, dtsPath);
    if (existingDts === undefined || !bytesEqual(existingDts, expectedDts)) {
      await fileService.writeFile(dtsPath, source);
    }

    const existingPkg = await readFileBytes(fileService, pkgPath);
    if (existingPkg === undefined || !bytesEqual(existingPkg, expectedPkg)) {
      await fileService.writeFile(pkgPath, pkgJson);
    }
  }
}
