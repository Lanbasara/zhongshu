/** Browser-only staging keeps failed/interrupted uploads recoverable across reload. */
export type UploadDraft = { id: string; conversation: string; file: File };
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zhongshu-upload-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('uploads', { keyPath: 'id' });
    request.onerror = () => reject(Error('upload_draft_storage_failed'));
    request.onsuccess = () => resolve(request.result);
  });
}
function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T>;
function transaction(mode: IDBTransactionMode, action: (store: IDBObjectStore) => void): Promise<void>;
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | void> {
  const db = await database();
  try { return await new Promise<T | void>((resolve, reject) => { const tx = db.transaction('uploads', mode); const request = action(tx.objectStore('uploads')); tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(Error('upload_draft_storage_failed')); tx.onabort = () => reject(Error('upload_draft_storage_failed')); }); }
  finally { db.close(); }
}
export async function uploadDrafts(conversation: string) { return (await transaction('readonly', s => s.getAll()) as UploadDraft[]).filter(u => u.conversation === conversation); }
export async function putUpload(draft: UploadDraft) { await transaction('readwrite', s => s.put(draft)); }
export async function removeUpload(id: string) { await transaction('readwrite', s => s.delete(id)); }
/** Move staged files when the existing conversation composer takes over. */
export async function handOverUploads(items: UploadDraft[], conversation: string, uploaded: Record<string, string>) {
  if (!items.length) return;
  await transaction('readwrite', store => {
    for (const item of items) {
      if (Object.hasOwn(uploaded, item.id)) store.delete(item.id);
      else store.put({ ...item, conversation });
    }
  });
}
export async function clearUploads() { await transaction('readwrite', s => s.clear()); }
