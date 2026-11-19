import { serveWebWorkerRuntime } from '@taucad/runtime/worker/web';
import { runtime } from '#runtime/definitions/replicad.js';

await serveWebWorkerRuntime({ runtime });
