// IndexedDB：整份資料存成單一物件（資料量小，備份／還原／遷移都簡單）
const open = () => new Promise((res, rej) => {
  const r = indexedDB.open('izu-a-plan', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const req = fn(db.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
};
export const load = (key = 'state') => tx('readonly', s => s.get(key));
export const save = (state, key = 'state') => tx('readwrite', s => s.put(structuredClone(state), key));
export const clear = (key = 'state') => tx('readwrite', s => s.delete(key));
export async function persist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
