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
export const load = () => tx('readonly', s => s.get('state'));
export const save = state => tx('readwrite', s => s.put(structuredClone(state), 'state'));
export const clear = () => tx('readwrite', s => s.delete('state'));
export async function persist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
