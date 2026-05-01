/**
 * Zod schemas for the bundled node-worker transport.
 *
 * @internal
 */

import { z } from 'zod';
import { isRuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
import type { RuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
import type { KernelWorker } from '#framework/kernel-worker.js';

const workerCtorSchema = z.custom<unknown>((value) => typeof value === 'function');

const runtimeFileSystemSchema = z.custom<RuntimeFileSystem>(
  (value) => value === undefined || isRuntimeFileSystem(value),
);

export const nodeWorkerClientOptionsSchema = z
  .object({
    /**
     * URL of the worker module entry. Must resolve to an ESM file that
     * boots the runtime worker dispatcher. Optional — when omitted the
     * transport defaults to the bundled `@taucad/runtime/worker/node`
     * entry; override only when hosting a custom worker module.
     */
    url: z.union([z.string(), z.instanceof(URL)]).optional(),
    /**
     * Override for `node:worker_threads.Worker` — primary use is
     * unit-test injection of a fake worker.
     */
    workerCtor: workerCtorSchema.optional(),
    /**
     * Optional shared-memory pool descriptor.
     */
    sharedMemory: z
      .object({
        geometry: z
          .object({
            bytes: z.number().int().positive(),
          })
          .optional(),
      })
      .optional(),
    /**
     * Optional filesystem handle produced by a `fromX` factory.
     */
    fileSystem: runtimeFileSystemSchema.optional(),
  })
  .strict();

/**
 * Worker-side {@link KernelWorker} instance to bridge into the channel.
 */
const kernelWorkerSchema = z.custom<KernelWorker>((value) => typeof value === 'object' && value !== null);

export const nodeWorkerHostOptionsSchema = z
  .object({
    worker: kernelWorkerSchema,
  })
  .strict();
