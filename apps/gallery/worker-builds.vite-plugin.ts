import type { Plugin } from 'vite';

/** Keep independent CAD and viewer worker bundles from occupying memory at the same time. */
export const galleryWorkerBuilds = (): Plugin => {
  let previousBuild = Promise.resolve();
  return {
    name: 'gallery-worker-builds',
    apply: 'build',
    config() {
      return {
        worker: {
          plugins() {
            let release: (() => void) | undefined;
            let workerDepth = 0;
            const sequentialWorker: Plugin = {
              name: 'gallery-sequential-worker-build',
              configResolved(config) {
                // Vite supplies this ancestry to worker configs, but omits it
                // from the public ResolvedConfig type. Check the runtime shape.
                if (!('bundleChain' in config) || !Array.isArray(config.bundleChain)) {
                  throw new Error('The gallery worker scheduler requires Vite worker build ancestry.');
                }
                workerDepth = config.bundleChain.length;
              },
              async buildStart() {
                // Nested workers must remain free to finish while their parent
                // builds. Top-level viewer workers share the CAD workers' queue.
                if (workerDepth === 1) {
                  const pending = previousBuild;
                  const completion = Promise.withResolvers<void>();
                  previousBuild = completion.promise;
                  release = completion.resolve;
                  await pending;
                }
              },
              buildEnd(error) {
                if (error) {
                  release?.();
                }
              },
              closeBundle() {
                release?.();
              },
            };
            return [sequentialWorker];
          },
        },
      };
    },
  };
};
