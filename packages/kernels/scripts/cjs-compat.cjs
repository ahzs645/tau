// Ensure CJS globals are available when OpenCASCADE WASM modules
// are loaded in ESM context by tsx/vitest transformers.
// eslint-disable-next-line no-undef
if (typeof globalThis.__dirname === 'undefined') {
  globalThis.__dirname = __dirname;
}

if (typeof globalThis.__filename === 'undefined') {
  globalThis.__filename = __filename;
}

if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = () => Promise.reject(new Error('fetch not available'));
}
