import { serveWebWorkerRuntime } from '@taucad/runtime/worker/web';
import { runtime } from '#runtime/definitions/openscad.js';

await serveWebWorkerRuntime({ runtime });
