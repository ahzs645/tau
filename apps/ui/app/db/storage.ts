import { IndexedDbStorageProvider } from '#db/indexeddb-storage.js';

// IndexedDB storage for build metadata and domain data
export const storage = new IndexedDbStorageProvider();
