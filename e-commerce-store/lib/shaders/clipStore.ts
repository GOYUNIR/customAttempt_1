// Browser IndexedDB store for hero WebM/MP4 clips.
//
// Pre-rendered hero clips are multi-MB base64 blobs. Storing them inside
// `store:config.aiHero.clips` means every `/api/store` / `/api/catalog/status`
// response — and every Cloudflare Edge/Redis round-trip — carries the full video
// payload, which is what triggers Worker Error 1102 (resource exceeded). This
// module moves the BLOB into the visitor's browser IndexedDB and leaves only a
// tiny metadata record (id + mime + bytes + dims) in the Redis-served config.
//
// BROWSER-ONLY, but importable from `node --test` because every IndexedDB access
// is guarded by `typeof indexedDB !== 'undefined'`.

const DB_NAME = 'goyunir-hero-clips';
const STORE = 'clips';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

function withStore(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<IDBRequest['result'] | null> {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  });
}

/** Persist a clip's data URL under its id (overwrites). */
export function putHeroClipBlob(id: string, dataUrl: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(false);
  return withStore('readwrite', (s) => s.put({ id, dataUrl }))
    .then(() => true)
    .catch(() => false);
}

/** Read a clip's data URL from IndexedDB (null when absent/unsupported). */
export function getHeroClipBlob(id: string): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return withStore('readonly', (s) => s.get(id))
    .then((rec) => (rec && typeof (rec as any).dataUrl === 'string' ? (rec as any).dataUrl : null))
    .catch(() => null);
}

/** Delete a clip's blob from IndexedDB. */
export function deleteHeroClipBlob(id: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(false);
  return withStore('readwrite', (s) => s.delete(id))
    .then(() => true)
    .catch(() => false);
}
