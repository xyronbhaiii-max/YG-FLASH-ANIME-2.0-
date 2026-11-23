import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import {
  getAuth,
  Auth,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from "firebase/auth";
import { getDatabase, Database } from "firebase/database";
import {
  getFirestore,
  Firestore,
  doc,
  getDocFromServer,
} from "firebase/firestore";
import {
  getStorage,
  FirebaseStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  UploadTask,
} from "firebase/storage";
import firebaseConfig from "../../firebase-applet-config.json";
import { apiUrl } from "../utils/apiUrl";

export const AUTHORIZED_ADMIN_EMAIL = "xyronbhaiii@gmail.com";

const configuredRtdbUrl =
  (firebaseConfig as Record<string, string>).databaseURL ||
  `https://${firebaseConfig.projectId}-default-rtdb.firebaseio.com`;

const fullFirebaseConfig = {
  ...firebaseConfig,
  databaseURL: configuredRtdbUrl,
};

export const app: FirebaseApp = getApps().length
  ? getApp()
  : initializeApp(fullFirebaseConfig);

export const auth: Auth = getAuth(app);
if (typeof window !== "undefined") {
  setPersistence(auth, browserLocalPersistence).catch(() => {
    setPersistence(auth, browserSessionPersistence).catch(() => {});
  });
}

export const firestoreDb: Firestore = getFirestore(
  app,
  firebaseConfig.firestoreDatabaseId
);

export const rtdb: Database = getDatabase(app, configuredRtdbUrl);

export const storage: FirebaseStorage = getStorage(app);
storage.maxUploadRetryTime = 10000;
storage.maxOperationRetryTime = 10000;

// Required connection verification on boot
async function testFirestoreConnection() {
  try {
    await getDocFromServer(doc(firestoreDb, "test", "connection"));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("the client is offline")
    ) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testFirestoreConnection();

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export interface UploadProgressInfo {
  percent: number;
  bytesTransferred: number;
  totalBytes: number;
  state: "running" | "paused" | "success" | "canceled" | "error";
}

export interface UploadCancelHandle {
  cancel: () => void;
}

function sanitizeStorageFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
}

/**
 * Uploads a video or image file from the device gallery to Firebase Storage
 * with live upload percentage progress and returns the Firebase Storage download URL.
 */
export function uploadMediaToFirebaseStorage(
  file: File,
  folder: "videos" | "posters" | "banners",
  onProgress?: (info: UploadProgressInfo) => void,
  onTaskCreated?: (task: UploadTask) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const safeName = sanitizeStorageFilename(file.name || `${folder}_media`);
    const path = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safeName}`;
    const fileRef = storageRef(storage, path);

    const contentType =
      file.type ||
      (folder === "videos" ? "video/mp4" : "image/jpeg");

    const uploadTask = uploadBytesResumable(fileRef, file, {
      contentType,
      customMetadata: {
        uploadedBy: auth.currentUser?.email || "admin",
        originalName: file.name || "gallery-media",
      },
    });

    if (onTaskCreated) {
      onTaskCreated(uploadTask);
    }

    uploadTask.on(
      "state_changed",
      (snapshot) => {
        const total = snapshot.totalBytes || file.size || 1;
        const percent = Math.min(
          100,
          Math.max(0, Math.round((snapshot.bytesTransferred / total) * 100))
        );
        if (onProgress) {
          onProgress({
            percent,
            bytesTransferred: snapshot.bytesTransferred,
            totalBytes: total,
            state: snapshot.state === "paused" ? "paused" : "running",
          });
        }
      },
      (error: any) => {
        const code = error?.code || "";
        if (onProgress) {
          onProgress({
            percent: 0,
            bytesTransferred: 0,
            totalBytes: file.size || 0,
            state: code === "storage/canceled" ? "canceled" : "error",
          });
        }
        if (code === "storage/unauthorized") {
          reject(
            new Error(
              "Firebase Storage permission denied. Sign in with the verified Admin Email & Password in Admin Portal and ensure Firebase Storage rules allow admin writes."
            )
          );
        } else if (code === "storage/canceled") {
          reject(new Error("Upload canceled."));
        } else {
          reject(new Error(error?.message || "Firebase Storage upload failed."));
        }
      },
      async () => {
        try {
          const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
          if (onProgress) {
            onProgress({
              percent: 100,
              bytesTransferred: file.size,
              totalBytes: file.size,
              state: "success",
            });
          }
          resolve(downloadUrl);
        } catch (err: any) {
          reject(
            new Error(
              err?.message || "Uploaded to Firebase Storage, but failed to get download URL."
            )
          );
        }
      }
    );
  });
}

export async function isFirebaseStorageBucketReady(): Promise<boolean> {
  if (!auth.currentUser || !firebaseConfig.storageBucket) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(
      `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(firebaseConfig.storageBucket)}/o?maxResults=1`,
      { method: "GET", signal: controller.signal }
    );
    clearTimeout(timer);
    return res.status !== 404 && res.status !== 400;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

function isValidJwtFormat(token: string): boolean {
  return Boolean(token && token.split(".").length === 3 && token.length > 40);
}

export async function getValidAdminIdToken(forceRefresh = false): Promise<string> {
  try {
    try {
      localStorage.removeItem("yg_admin_token");
      localStorage.removeItem("yg_admin_user");
    } catch {}

    if (typeof (auth as any).authStateReady === "function" && !auth.currentUser) {
      await Promise.race([
        (auth as any).authStateReady(),
        new Promise<void>((resolve) => setTimeout(resolve, 3500)),
      ]);
    }

    const user = auth.currentUser;
    if (!user || !user.email || !user.emailVerified) {
      return "";
    }
    if (user.email.toLowerCase() !== AUTHORIZED_ADMIN_EMAIL.toLowerCase()) {
      return "";
    }

    const token = await Promise.race([
      user.getIdToken(forceRefresh),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 8000)),
    ]);

    return isValidJwtFormat(token) ? token : "";
  } catch {
    return "";
  }
}

export async function buildAdminAuthHeaders(
  forceRefresh = false,
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const token = await getValidAdminIdToken(forceRefresh);
  if (!token) {
    throw new Error(
      "Unauthorized: Sign in with authorized admin Gmail (xyronbhaiii@gmail.com) to continue."
    );
  }
  return {
    ...extra,
    Authorization: `Bearer ${token}`,
  };
}

export async function refreshAdminUploadToken(): Promise<string> {
  return getValidAdminIdToken(true);
}

interface ChunkTask {
  id: number;
  offset: number;
  size: number;
  retriesLeft: number;
}

async function uploadVideoChunkedToServer(
  file: File,
  adminToken: string,
  onProgress?: (info: UploadProgressInfo) => void,
  onCancelHandle?: (handle: UploadCancelHandle) => void
): Promise<string> {
  if (!file || file.size <= 0) {
    throw new Error("Selected video file is empty or unreadable.");
  }

  let effectiveToken = isValidJwtFormat(adminToken)
    ? adminToken
    : await getValidAdminIdToken(false);
  if (!effectiveToken) {
    effectiveToken = await getValidAdminIdToken(true);
  }
  if (!effectiveToken) {
    throw new Error(
      "Unauthorized: Missing or invalid admin authorization header. Sign in as xyronbhaiii@gmail.com."
    );
  }

  const INITIAL_CHUNK_SIZE = 1024 * 1024; // 1 MB chunks: fast & proxy-safe across Wi-Fi, 4G/5G
  const MIN_SPLIT_SIZE = 256 * 1024;      // Auto-splits down to 256 KB if any carrier/proxy throttles
  const MAX_CHUNK_RETRIES = 6;
  const STALL_TIMEOUT_MS = 18000;         // Abort & retry stalled sockets in 18s (never freeze for 90s+)
  const HARD_CHUNK_TIMEOUT_MS = 45000;

  const totalBytes = file.size;
  const uploadId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const queue: ChunkTask[] = [];
  let taskIdCounter = 0;
  for (let offset = 0; offset < totalBytes; offset += INITIAL_CHUNK_SIZE) {
    queue.push({
      id: taskIdCounter++,
      offset,
      size: Math.min(INITIAL_CHUNK_SIZE, totalBytes - offset),
      retriesLeft: MAX_CHUNK_RETRIES,
    });
  }
  const initialTotalChunks = queue.length;

  let canceled = false;
  let fatalError: Error | null = null;
  let tokenRefreshedOnce = false;
  let completedBytes = 0;
  let maxReportedBytes = 0;
  let maxWorkers = initialTotalChunks > 1 ? 2 : 1;
  let activeWorkers = 0;

  const activeXhrs = new Set<XMLHttpRequest>();
  const inFlightLoaded = new Map<number, number>();

  // Prevent mobile browser / Android screen sleep throttling during long uploads
  let wakeLock: any = null;
  try {
    if (typeof navigator !== "undefined" && (navigator as any).wakeLock?.request) {
      wakeLock = await (navigator as any).wakeLock.request("screen");
    }
  } catch {
    // Ignore if wakeLock is unsupported or blocked
  }

  const emitProgress = () => {
    if (canceled) return;
    let inFlightSum = 0;
    inFlightLoaded.forEach((v) => {
      inFlightSum += v;
    });
    const rawTotal = Math.min(totalBytes, completedBytes + inFlightSum);
    maxReportedBytes = Math.max(maxReportedBytes, rawTotal);
    const percent = Math.min(99, Math.max(0, Math.round((maxReportedBytes / totalBytes) * 100)));
    onProgress?.({
      percent,
      bytesTransferred: maxReportedBytes,
      totalBytes,
      state: "running",
    });
  };

  window.dispatchEvent(new CustomEvent("yg:upload-state", { detail: { active: true } }));

  if (onCancelHandle) {
    onCancelHandle({
      cancel: () => {
        canceled = true;
        activeXhrs.forEach((xhr) => {
          try {
            xhr.abort();
          } catch {}
        });
        activeXhrs.clear();
        fetch(apiUrl(`/api/upload-chunk/${uploadId}`), {
          method: "DELETE",
          credentials: "include",
          headers: { Authorization: `Bearer ${effectiveToken}` },
        }).catch(() => {});
      },
    });
  }

  const sendSliceOnce = (task: ChunkTask): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (canceled) {
        reject(new Error("Upload canceled."));
        return;
      }

      const chunkBlob = file.slice(task.offset, task.offset + task.size);
      const formData = new FormData();
      formData.append("chunk", chunkBlob, "chunk.bin");
      formData.append("uploadId", uploadId);
      formData.append("chunkIndex", String(task.id));
      formData.append("chunkOffset", String(task.offset));
      formData.append("totalChunks", String(initialTotalChunks));
      formData.append("deferFinalize", "1");
      formData.append("filename", file.name || "video.mp4");

      const xhr = new XMLHttpRequest();
      activeXhrs.add(xhr);

      let settled = false;
      let stalledAbort = false;
      let lastActivity = Date.now();

      const stallWatchdog = setInterval(() => {
        if (settled) {
          clearInterval(stallWatchdog);
          return;
        }
        if (Date.now() - lastActivity > STALL_TIMEOUT_MS) {
          stalledAbort = true;
          clearInterval(stallWatchdog);
          try {
            xhr.abort();
          } catch {}
        }
      }, 2000);

      const cleanup = () => {
        settled = true;
        clearInterval(stallWatchdog);
        activeXhrs.delete(xhr);
        inFlightLoaded.delete(task.id);
      };

      xhr.open("POST", apiUrl("/api/upload-chunk"));
      xhr.withCredentials = true;
      xhr.timeout = HARD_CHUNK_TIMEOUT_MS;
      if (effectiveToken) {
        xhr.setRequestHeader("Authorization", `Bearer ${effectiveToken}`);
      }

      xhr.upload.onloadstart = () => {
        lastActivity = Date.now();
      };

      xhr.upload.onprogress = (evt) => {
        if (canceled || settled) return;
        lastActivity = Date.now();
        if (evt.lengthComputable) {
          inFlightLoaded.set(task.id, Math.min(task.size, evt.loaded));
          emitProgress();
        }
      };

      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            JSON.parse(xhr.responseText);
            window.dispatchEvent(new CustomEvent("yg:upload-pulse"));
            resolve();
          } catch {
            reject(new Error("Invalid server response during video upload."));
          }
        } else {
          let errMsg = `Upload failed (HTTP ${xhr.status}).`;
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed?.error) errMsg = parsed.error;
          } catch {}
          const err = new Error(errMsg) as Error & { status?: number };
          err.status = xhr.status;
          reject(err);
        }
      };

      xhr.onerror = () => {
        cleanup();
        reject(new Error("Network interruption while uploading video chunk."));
      };

      xhr.ontimeout = () => {
        cleanup();
        reject(new Error("Upload timed out while sending video chunk."));
      };

      xhr.onabort = () => {
        cleanup();
        if (stalledAbort && !canceled) {
          reject(new Error("Upload connection stalled, retrying chunk..."));
        } else {
          reject(new Error("Upload canceled."));
        }
      };

      xhr.send(formData);
    });
  };

  try {
    // Run queue with adaptive concurrency (up to 2 workers; drops to 1 and/or splits chunks on trouble)
    await new Promise<void>((resolveAll, rejectAll) => {
      const pump = () => {
        if (canceled) {
          if (activeWorkers === 0) rejectAll(new Error("Upload canceled."));
          return;
        }
        if (fatalError) {
          if (activeWorkers === 0) rejectAll(fatalError);
          return;
        }
        if (queue.length === 0 && activeWorkers === 0) {
          resolveAll();
          return;
        }

        while (!canceled && !fatalError && activeWorkers < maxWorkers && queue.length > 0) {
          const task = queue.shift()!;
          activeWorkers++;

          (async () => {
            try {
              // Wait briefly if switching between Wi-Fi and mobile data
              if (typeof navigator !== "undefined" && !navigator.onLine) {
                await new Promise<void>((resolve) => {
                  const onBackOnline = () => {
                    window.removeEventListener("online", onBackOnline);
                    resolve();
                  };
                  window.addEventListener("online", onBackOnline);
                  setTimeout(() => {
                    window.removeEventListener("online", onBackOnline);
                    resolve();
                  }, 5000);
                });
              }

              await sendSliceOnce(task);
              completedBytes += task.size;
              emitProgress();
            } catch (err: any) {
              if (canceled || err?.message === "Upload canceled.") {
                canceled = true;
                return;
              }

              // Auto-recover admin session token if 401/403 occurs mid-upload
              if ((err?.status === 401 || err?.status === 403) && !tokenRefreshedOnce) {
                tokenRefreshedOnce = true;
                const freshToken = await refreshAdminUploadToken();
                if (freshToken) {
                  effectiveToken = freshToken;
                  queue.unshift(task);
                  return;
                }
              }

              if (err?.status === 400 || err?.status === 401 || err?.status === 403) {
                fatalError = err instanceof Error ? err : new Error(String(err));
                activeXhrs.forEach((x) => { try { x.abort(); } catch {} });
                return;
              }

              // Reduce concurrency on unstable mobile signal and auto-split big slices on 413/stalls
              maxWorkers = 1;
              if ((err?.status === 413 || task.retriesLeft <= 3) && task.size > MIN_SPLIT_SIZE) {
                const half = Math.ceil(task.size / 2);
                const firstHalf: ChunkTask = {
                  id: taskIdCounter++,
                  offset: task.offset,
                  size: half,
                  retriesLeft: MAX_CHUNK_RETRIES,
                };
                const secondHalf: ChunkTask = {
                  id: taskIdCounter++,
                  offset: task.offset + half,
                  size: task.size - half,
                  retriesLeft: MAX_CHUNK_RETRIES,
                };
                queue.unshift(firstHalf, secondHalf);
                await new Promise((r) => setTimeout(r, 600));
                return;
              }

              if (task.retriesLeft > 0) {
                task.retriesLeft -= 1;
                queue.unshift(task);
                await new Promise((r) => setTimeout(r, 1200));
                return;
              }

              fatalError = err instanceof Error ? err : new Error(String(err));
              activeXhrs.forEach((x) => { try { x.abort(); } catch {} });
            } finally {
              activeWorkers--;
              pump();
            }
          })();
        }
      };

      pump();
    });

    if (canceled) {
      onProgress?.({
        percent: 0,
        bytesTransferred: 0,
        totalBytes: file.size,
        state: "canceled",
      });
      throw new Error("Upload canceled.");
    }

    // Finalize assembled chunks on server (with quick auto-retry)
    let finalUrl = "";
    let finalizeErr: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (canceled) throw new Error("Upload canceled.");
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const finalizeHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${effectiveToken}`,
        };
        const res = await fetch(apiUrl("/api/upload-chunk/complete"), {
          method: "POST",
          credentials: "include",
          headers: finalizeHeaders,
          body: JSON.stringify({
            uploadId,
            filename: file.name || "video.mp4",
            expectedSize: totalBytes,
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        if ((res.status === 401 || res.status === 403) && !tokenRefreshedOnce) {
          tokenRefreshedOnce = true;
          const freshToken = await getValidAdminIdToken(true);
          if (freshToken) {
            effectiveToken = freshToken;
            continue;
          }
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || `Finalization failed (HTTP ${res.status}).`);
        }
        if (data?.url) {
          finalUrl = data.url;
          finalizeErr = null;
          break;
        }
      } catch (err: any) {
        finalizeErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    if (finalizeErr || !finalUrl) {
      throw finalizeErr || new Error("Video upload finished without a playable URL.");
    }

    onProgress?.({
      percent: 100,
      bytesTransferred: file.size,
      totalBytes: file.size,
      state: "success",
    });

    return finalUrl;
  } catch (err: any) {
    if (err?.message !== "Upload canceled.") {
      onProgress?.({
        percent: Math.round((maxReportedBytes / totalBytes) * 100),
        bytesTransferred: maxReportedBytes,
        totalBytes: file.size,
        state: "error",
      });
    } else {
      onProgress?.({
        percent: 0,
        bytesTransferred: 0,
        totalBytes: file.size,
        state: "canceled",
      });
    }
    throw err;
  } finally {
    window.dispatchEvent(new CustomEvent("yg:upload-state", { detail: { active: false } }));
    try {
      await wakeLock?.release?.();
    } catch {}
  }
}

/**
 * Smart video uploader: uses Firebase Storage when bucket & Firebase Auth are active,
 * and seamlessly falls back to chunked streaming upload on Express if the Firebase
 * Storage bucket is unprovisioned (HTTP 404) or returns an infrastructure failure.
 */
export async function uploadVideoWithChunkFallback(
  file: File,
  adminToken: string,
  onProgress?: (info: UploadProgressInfo) => void,
  onCancelHandle?: (handle: UploadCancelHandle) => void
): Promise<string> {
  const fbReady = await isFirebaseStorageBucketReady();
  if (fbReady) {
    try {
      return await uploadMediaToFirebaseStorage(
        file,
        "videos",
        onProgress,
        (task) => {
          if (onCancelHandle) {
            onCancelHandle({ cancel: () => task.cancel() });
          }
        }
      );
    } catch (err: any) {
      if (err?.message === "Upload canceled.") {
        throw err;
      }
      // Fall back to chunked server upload if Firebase Storage fails unexpectedly
    }
  }

  return uploadVideoChunkedToServer(file, adminToken, onProgress, onCancelHandle);
}
