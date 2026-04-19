/* oxlint-disable no-barrel-files/no-barrel-files -- transcoder factory re-exports */

/**
 * Consumer-facing transcoder plugin factory functions.
 *
 * Each transcoder owns its registration metadata in a co-located `*.plugin.ts` file.
 * This module re-exports all transcoder factories for public consumption.
 */

export { converterTranscoder } from '#transcoders/converter/converter.plugin.js';
