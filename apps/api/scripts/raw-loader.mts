/**
 * Registers the `?raw` import loader hooks with Node.js.
 * Used via `node --import ./scripts/raw-loader.mts`.
 */

import { register } from 'node:module';

register('./raw-loader-hooks.mts', import.meta.url);
