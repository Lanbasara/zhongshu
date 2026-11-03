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
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try { return await new Promise<T>((resolve, reject) => { const tx = db.transaction('uploads', mode); const request = action(tx.objectStore('uploads')); tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(Error('upload_draft_storage_failed')); tx.onabort = () => reject(Error('upload_draft_storage_failed')); }); }
  finally { db.close(); }
}
export async function uploadDrafts(conversation: string) { return (await transaction('readonly', s => s.getAll()) as UploadDraft[]).filter(u => u.conversation === conversation); }
export async function putUpload(draft: UploadDraft) { await transaction('readwrite', s => s.put(draft)); }
export async function removeUpload(id: string) { await transaction('readwrite', s => s.delete(id)); }
export async function clearUploads() { await transaction('readwrite', s => s.clear()); }
