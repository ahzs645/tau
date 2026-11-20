import { serveWebWorkerRuntime } from '@taucad/runtime/worker/web';
import { runtime } from '#runtime/definitions/openrscad.js';

await serveWebWorkerRuntime({ runtime });
