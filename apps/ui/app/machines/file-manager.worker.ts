/**
 * File-Manager Worker
 *
 * Single entry point for all filesystem access. Every connection (main thread,
 * kernel workers, git) receives a MessagePort that is served by the same
 * fileManager handler map -- sharing one ZenFS instance and one serialization
 * queue. This prevents the TOCTOU race condition in ZenFS's commitNew
 * (zen-fs/core#256).
 */

import { exposeFileSystem } from '@taucad/kernels/filesystem';
import { fileManager } from '#machines/file-manager.js';

exposeFileSystem(fileManager);
