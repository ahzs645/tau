import { serveWebWorkerRuntime } from '@taucad/runtime/worker/web';
import { runtime } from '#runtime/definitions/opencascade.js';

await serveWebWorkerRuntime({ runtime });
