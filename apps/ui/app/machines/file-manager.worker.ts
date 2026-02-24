import { expose } from 'comlink';
import { exposeFileSystem } from '@taucad/kernels/filesystem';
import { fromZenFS } from '@taucad/kernels';
import { fileManager } from '#machines/file-manager.js';
import type { FileManager } from '#machines/file-manager.js';
import { fs } from '#filesystem/zenfs-config.js';

expose(fileManager);
export const cleanupFileSystem = exposeFileSystem(fromZenFS(fs));

export type FileWorker = FileManager;
