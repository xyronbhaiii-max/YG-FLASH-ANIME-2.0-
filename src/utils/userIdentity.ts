const UID_STORAGE_KEY = "yg_device_uid";
const UID_COOKIE_NAME = "yg_device_uid";
const IDB_NAME = "yg_flash_identity_db";
const IDB_STORE = "identity";
const IDB_KEY = "device_uid";

function isValidUidFormat(val: unknown): val is string {
  return typeof val === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(val);
}

function readCookieUid(): string | null {
  if (typeof document === "undefined") return null;
  try {
    const parts = document.cookie.split(";");
    for (const part of parts) {
      const [rawKey, ...rawVal] = part.trim().split("=");
      if (rawKey === UID_COOKIE_NAME) {
        const val = decodeURIComponent(rawVal.join("="));
        if (isValidUidFormat(val)) return val;
      }
    }
  } catch {}
  return null;
}

function writeCookieUid(uid: string): void {
  if (typeof document === "undefined") return;
  try {
    const maxAge = 60 * 60 * 24 * 400; // 400 days persistent browser cookie
    document.cookie = `${UID_COOKIE_NAME}=${encodeURIComponent(uid)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  } catch {}
}

function writeLocalUid(uid: string): void {
  try {
    localStorage.setItem(UID_STORAGE_KEY, uid);
  } catch {}
}

function writeIndexedDbUid(uid: string): void {
  if (typeof indexedDB === "undefined") return;
  try {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => {
      try {
        const db = req.result;
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(uid, IDB_KEY);
      } catch {}
    };
  } catch {}
}

function readIndexedDbUid(): Promise<string | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => {
        try {
          const db = req.result;
          const tx = db.transaction(IDB_STORE, "readonly");
          const getReq = tx.objectStore(IDB_STORE).get(IDB_KEY);
          getReq.onsuccess = () => {
            const val = getReq.result;
            resolve(isValidUidFormat(val) ? val : null);
          };
          getReq.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function generateStableUid(): string {
  const ts = Date.now().toString(36);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    return `yg_${ts}_${hex}`;
  }
  const rand = Math.random().toString(36).slice(2, 12);
  return `yg_${ts}_${rand}`;
}

/**
 * Returns the permanent client UID (read synchronously from localStorage / cookie).
 * Generated ONCE per installation/device and mirrored to localStorage, HTTP cookie, and IndexedDB.
 * Never regenerated on render or refresh.
 */
export function getOrCreatePersistentDeviceUid(): string {
  if (typeof window === "undefined") return "yg_server_default";

  let existing: string | null = null;
  try {
    const lsVal = localStorage.getItem(UID_STORAGE_KEY);
    if (isValidUidFormat(lsVal)) existing = lsVal;
  } catch {}

  if (!existing) {
    existing = readCookieUid();
  }

  const uid = existing || generateStableUid();
  writeLocalUid(uid);
  writeCookieUid(uid);
  writeIndexedDbUid(uid);
  return uid;
}

/**
 * Recovers UID from IndexedDB if localStorage & cookie were wiped independently,
 * or keeps the current authoritative UID mirrored across all three stores.
 */
export async function syncIndexedDbDeviceUid(currentUid: string): Promise<string> {
  const idbUid = await readIndexedDbUid();
  const cookieUid = readCookieUid();
  let lsUid: string | null = null;
  try {
    const val = localStorage.getItem(UID_STORAGE_KEY);
    if (isValidUidFormat(val)) lsUid = val;
  } catch {}

  const recovered = lsUid || cookieUid || idbUid || currentUid;
  writeLocalUid(recovered);
  writeCookieUid(recovered);
  writeIndexedDbUid(recovered);
  return recovered;
}
