import { useCallback, useMemo, useRef, useState } from 'react';
import type { FileSystemClient } from '@taucad/fs-client/file-system-client';
import { bundledTypesWorkspaceRootSegment } from '#lib/bundled-types-tree.constants.js';

export type BundledTypesTreeHook = Readonly<{
  /** All workspace-relative paths discovered from {@link proxy} (includes folders + files). */
  bundledPaths: Set<string>;
  /** Load `/node_modules` listing once (idempotent). */
  ensureRootListed: () => Promise<void>;
  /** Load `/node_modules/<pkg>` listing once per package (idempotent). */
  ensurePkgListed: (pkg: string) => Promise<void>;
}>;

/**
 * Lazy `readdir` over the FM global bundled-types mount (`/node_modules`),
 * mapped to workspace-relative paths `node_modules/<pkg>/…` for the file tree.
 *
 * @public
 */
export function useBundledTypesTree(proxy: FileSystemClient | undefined | null): BundledTypesTreeHook {
  const [rootPkgs, setRootPkgs] = useState<string[] | undefined>(undefined);
  const [pkgFiles, setPkgFiles] = useState<Partial<Record<string, string[]>>>({});

  const rootPkgsRef = useRef<string[] | undefined>(undefined);
  const rootListingRef = useRef<Promise<void> | undefined>(undefined);
  const pkgFilesRef = useRef<Partial<Record<string, string[]>>>({});
  const pkgListingRefs = useRef(new Map<string, Promise<void>>());

  const ensureRootListed = useCallback(async (): Promise<void> => {
    if (!proxy || rootPkgsRef.current !== undefined) {
      return;
    }

    if (rootListingRef.current) {
      await rootListingRef.current;
      return;
    }

    rootListingRef.current = (async (): Promise<void> => {
      try {
        const names = await proxy.readdir(`/${bundledTypesWorkspaceRootSegment}`);
        rootPkgsRef.current = names;
        setRootPkgs(names);
      } finally {
        rootListingRef.current = undefined;
      }
    })();

    await rootListingRef.current;
  }, [proxy]);

  const ensurePkgListed = useCallback(
    async (pkg: string): Promise<void> => {
      if (!proxy || pkgFilesRef.current[pkg] !== undefined) {
        return;
      }

      const inFlight = pkgListingRefs.current.get(pkg);
      if (inFlight) {
        await inFlight;
        return;
      }

      const listing = (async (): Promise<void> => {
        try {
          const names = await proxy.readdir(`/${bundledTypesWorkspaceRootSegment}/${pkg}`);
          pkgFilesRef.current = { ...pkgFilesRef.current, [pkg]: names };
          setPkgFiles((previous) => ({ ...previous, [pkg]: names }));
        } finally {
          pkgListingRefs.current.delete(pkg);
        }
      })();

      pkgListingRefs.current.set(pkg, listing);
      await listing;
    },
    [proxy],
  );

  const bundledPaths = useMemo(() => {
    const paths = new Set<string>();
    if (!proxy) {
      return paths;
    }

    paths.add(bundledTypesWorkspaceRootSegment);

    if (rootPkgs) {
      for (const pkg of rootPkgs) {
        paths.add(`${bundledTypesWorkspaceRootSegment}/${pkg}`);
        const files = pkgFiles[pkg];
        if (files) {
          for (const file of files) {
            paths.add(`${bundledTypesWorkspaceRootSegment}/${pkg}/${file}`);
          }
        }
      }
    }

    return paths;
  }, [rootPkgs, pkgFiles]);

  return { bundledPaths, ensureRootListed, ensurePkgListed };
}
