import { IndexedDbStorageProvider } from '#db/indexeddb-storage.js';

// IndexedDB storage for project metadata and domain data
export const storage = new IndexedDbStorageProvider();
