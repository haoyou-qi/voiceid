// 聲紋檔的保存：同時存在 localStorage 和 IndexedDB，並請瀏覽器「長期保存」，降低被清掉的機會。
// 另外提供備份檔（匯出 / 匯入），換手機、換瀏覽器或資料被清掉時可以還原。

import type { Profile } from './dsp/types';

const DB = 'voiceid';
const STORE = 'kv';
const KEY = 'profiles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 請瀏覽器把這個網站的資料當成「重要資料」長期保存（瀏覽器可能不同意，不影響使用） */
export async function requestPersist(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** 讀取聲紋檔：localStorage 沒有（被清掉）就從 IndexedDB 找回來 */
export async function loadProfilesFromStorage(lsKey: string): Promise<Profile[]> {
  let list: Profile[] = [];
  try {
    list = JSON.parse(localStorage.getItem(lsKey) || '[]');
  } catch { /* 略過 */ }
  if (!list.length) {
    try {
      list = (await idbGet<Profile[]>(KEY)) ?? [];
    } catch { /* 略過 */ }
  }
  // 舊版檔案沒有 kind 欄位，都是 GMM 建的
  return list.map((p) => ({ ...p, kind: p.kind ?? 'gmm' }) as Profile);
}

/** 存兩份：localStorage + IndexedDB */
export async function saveProfilesToStorage(lsKey: string, profiles: Profile[]) {
  try { localStorage.setItem(lsKey, JSON.stringify(profiles)); } catch { /* 略過 */ }
  try { await idbSet(KEY, profiles); } catch { /* 略過 */ }
}

// ---------- 備份檔 ----------

export interface RemoteBackup { url: string; key: string; mode?: string }

interface Backup {
  app: 'voiceid';
  version: 1;
  exportedAt: string;
  profiles: Profile[];
  remote?: RemoteBackup; // 電腦運算的網址和金鑰（有設定才會有）
}

/** 匯出備份檔：手機上跳出分享選單（可存到「檔案」或傳 LINE 給自己），電腦上直接下載 */
export async function exportBackup(profiles: Profile[], remote?: RemoteBackup): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const data: Backup = { app: 'voiceid', version: 1, exportedAt: new Date().toISOString(), profiles };
  if (remote?.url && remote.key) data.remote = remote;
  const d = new Date();
  const name = `voiceid-聲紋備份-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'VoiceID 聲紋備份' });
      return 'shared';
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled';
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}

/** 讀取備份檔，回傳裡面的聲紋檔（格式不對會丟錯） */
export async function readBackup(file: File): Promise<{ profiles: Profile[]; remote?: RemoteBackup }> {
  const data = JSON.parse(await file.text()) as Partial<Backup>;
  if (data.app !== 'voiceid' || !Array.isArray(data.profiles)) throw new Error('這不是 VoiceID 的備份檔');
  for (const p of data.profiles) {
    if (!p || typeof p.name !== 'string' || !p.kind) throw new Error('備份檔內容有誤');
  }
  const r = data.remote;
  return { profiles: data.profiles, remote: r && typeof r.url === 'string' && typeof r.key === 'string' ? r : undefined };
}

/** 是否在 LINE / Facebook / Instagram 這類 app 內建瀏覽器（資料容易被清掉、也可能拿不到麥克風） */
export function inAppBrowserName(): string | null {
  const ua = navigator.userAgent;
  if (/ Line\//i.test(ua)) return 'LINE';
  if (/FBAN|FBAV/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  return null;
}
