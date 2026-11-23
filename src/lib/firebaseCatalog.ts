import {
  ref as rtdbRef,
  set as rtdbSet,
  update as rtdbUpdate,
  remove as rtdbRemove,
  onValue,
  get as rtdbGet,
} from "firebase/database";
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  getDoc,
  getDocs,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import {
  auth,
  rtdb,
  firestoreDb,
  AUTHORIZED_ADMIN_EMAIL,
  handleFirestoreError,
  OperationType,
} from "./firebase";
import { apiUrl } from "../utils/apiUrl";
import {
  type Anime,
  type Episode,
  type EpisodeLanguage,
  type ThemeType,
  type ThemeMode,
  type BackgroundPoster,
  type HistoryItem,
} from "../context/AppContext";
import { type SoundPack } from "../utils/sound";
import { dedupeIdList, dedupeWatchHistoryByAnime } from "../utils/historyDedupe";

function withTimeout<T>(promise: Promise<T>, ms = 8500): Promise<T | null> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timerId !== undefined) clearTimeout(timerId);
    }),
    new Promise<null>((resolve) => {
      timerId = setTimeout(() => resolve(null), ms);
    }),
  ]);
}

function withTimeoutStrict<T>(
  promise: Promise<T>,
  ms = 9000,
  label = "Cloud save"
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timerId !== undefined) clearTimeout(timerId);
    }),
    new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function isFirebaseVerifiedAdmin(): boolean {
  const user = auth.currentUser;
  return Boolean(
    user &&
      user.email?.toLowerCase() === AUTHORIZED_ADMIN_EMAIL &&
      user.emailVerified
  );
}

function isFirebaseOwner(uid: string): boolean {
  const user = auth.currentUser;
  return Boolean(user && user.uid === uid && user.emailVerified);
}

function normalizeTimestamp(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === "string" && val) {
    return val;
  }
  return new Date().toISOString();
}

function normalizeTimestampMillis(val: unknown): number {
  if (val instanceof Timestamp) {
    return val.toMillis();
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === "string" && val) {
    const parsed = Date.parse(val);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

function normalizeEpisodesCount(val: unknown, fallback = 0): number {
  if (val === undefined || val === null || val === "") return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(10000, Math.round(num)));
}

function normalizeAnimeRecord(raw: any, fallbackId?: string): Anime {
  const id = String(raw?.id || fallbackId || "");
  const cleanRating = String(raw?.rating || "").trim().slice(0, 32) || "13+";
  return {
    id,
    title: String(raw?.title || ""),
    titleJapanese: String(raw?.titleJapanese || ""),
    synopsis: String(raw?.synopsis || ""),
    posterImage: String(raw?.posterImage || ""),
    bannerImage: String(raw?.bannerImage || raw?.posterImage || ""),
    genres: Array.isArray(raw?.genres) ? raw.genres.map(String) : [],
    rating: cleanRating,
    ratingVerified:
      typeof raw?.ratingVerified === "boolean" ? raw.ratingVerified : undefined,
    status: raw?.status === "Completed" ? "Completed" : "Ongoing",
    year: Number(raw?.year) || new Date().getFullYear(),
    seasons: Number(raw?.seasons) || 1,
    episodesCount: normalizeEpisodesCount(raw?.episodesCount, 0),
    isPublished: raw?.isPublished !== false,
    featured: Boolean(raw?.featured),
    streamingSources: Array.isArray(raw?.streamingSources)
      ? raw.streamingSources
      : [],
    createdAt: normalizeTimestamp(raw?.createdAt),
    updatedAt: normalizeTimestamp(raw?.updatedAt),
  };
}

export function sortEpisodes(list: Episode[]): Episode[] {
  return [...list].sort((a, b) => {
    const seasonDiff = (a.season || 1) - (b.season || 1);
    if (seasonDiff !== 0) return seasonDiff;
    const orderA = a.order !== undefined ? a.order : a.number;
    const orderB = b.order !== undefined ? b.order : b.number;
    if (orderA !== orderB) return orderA - orderB;
    const numDiff = a.number - b.number;
    if (numDiff !== 0) return numDiff;
    return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  });
}

export function mergeEpisodeRecords(
  existing: Episode | undefined,
  incoming: Episode
): Episode {
  if (!existing) return incoming;
  const existingTs = Date.parse(existing.updatedAt || existing.createdAt || "") || 0;
  const incomingTs = Date.parse(incoming.updatedAt || incoming.createdAt || "") || 0;
  const incomingIsNewer = incomingTs >= existingTs;
  const newer = incomingIsNewer ? incoming : existing;
  const older = incomingIsNewer ? existing : incoming;

  const mergedSources =
    Array.isArray(newer.sources) && newer.sources.length > 0
      ? newer.sources
      : Array.isArray(older.sources)
      ? older.sources
      : [];

  return {
    ...older,
    ...newer,
    videoUrl: newer.videoUrl?.trim() ? newer.videoUrl : older.videoUrl,
    sources: mergedSources,
  };
}

export function mergeEpisodeLists(base: Episode[], incomingList: Episode[]): Episode[] {
  const map = new Map<string, Episode>();
  for (const ep of base) {
    if (ep?.id) map.set(ep.id, ep);
  }
  for (const ep of incomingList) {
    if (ep?.id) map.set(ep.id, mergeEpisodeRecords(map.get(ep.id), ep));
  }
  return sortEpisodes(Array.from(map.values()));
}

function normalizeLanguage(val: unknown): EpisodeLanguage {
  if (typeof val === "string") {
    const trimmed = val.trim().slice(0, 40);
    if (trimmed) return trimmed;
  }
  return "Japanese";
}

function normalizeEpisodeRecord(raw: any, fallbackId?: string): Episode {
  const id = String(raw?.id || fallbackId || "");
  const parsedNum = Number(raw?.number);
  const num = Number.isFinite(parsedNum) && parsedNum >= 0 ? Math.min(10000, Math.round(parsedNum)) : 1;
  const desc = String(raw?.description ?? raw?.synopsis ?? "");
  return {
    id,
    animeId: String(raw?.animeId || ""),
    number: num,
    season: Math.max(1, Number(raw?.season) || 1),
    title: String(raw?.title || `Episode ${num}`),
    language: normalizeLanguage(raw?.language),
    synopsis: desc,
    description: desc,
    duration: String(raw?.duration || "24m"),
    videoUrl: String(raw?.videoUrl || ""),
    thumbnailUrl: String(raw?.thumbnailUrl || ""),
    order: raw?.order !== undefined && !isNaN(Number(raw.order)) ? Number(raw.order) : num,
    sources: Array.isArray(raw?.sources) ? raw.sources : [],
    ...(typeof raw?.isPublished === "boolean" ? { isPublished: raw.isPublished } : {}),
    createdAt: normalizeTimestamp(raw?.createdAt),
    updatedAt: raw?.updatedAt ? normalizeTimestamp(raw.updatedAt) : undefined,
  };
}

/**
 * Saves or updates an anime entry in Firebase Realtime Database (primary realtime store)
 * and mirrors to Firestore when Firebase Auth admin session is active.
 */
export async function saveAnimeToFirebase(
  anime: Anime,
  isNew: boolean
): Promise<{ rtdbSaved: boolean; firestoreSaved: boolean; error?: string }> {
  let rtdbSaved = false;
  let firestoreSaved = false;
  let lastError = "";

  const normalizedCount = normalizeEpisodesCount(anime.episodesCount, 0);
  const cleanRating = String(anime.rating || "13+").trim().slice(0, 32) || "13+";
  const safeSynopsis =
    String(anime.synopsis || "").trim().slice(0, 5000) ||
    `Stream ${anime.title} in high speed on YG Flash Anime.`.slice(0, 5000);

  const rtdbPayload = {
    id: anime.id,
    title: anime.title,
    titleJapanese: anime.titleJapanese || "",
    synopsis: safeSynopsis,
    posterImage: anime.posterImage,
    bannerImage: anime.bannerImage || anime.posterImage,
    genres: anime.genres || [],
    rating: cleanRating,
    ...(typeof anime.ratingVerified === "boolean" ? { ratingVerified: anime.ratingVerified } : {}),
    status: anime.status,
    year: Number(anime.year) || new Date().getFullYear(),
    seasons: Number(anime.seasons) || 1,
    episodesCount: normalizedCount,
    isPublished: Boolean(anime.isPublished),
    featured: Boolean(anime.featured),
    streamingSources: anime.streamingSources || [],
    createdAt: anime.createdAt || new Date().toISOString(),
    updatedAt: anime.updatedAt || new Date().toISOString(),
  };

  if (isFirebaseVerifiedAdmin()) {
    try {
      await withTimeoutStrict(
        rtdbSet(rtdbRef(rtdb, `anime/${anime.id}`), rtdbPayload),
        8500,
        "RTDB anime save"
      );
      rtdbSaved = true;
    } catch (err: any) {
      lastError = err?.message || "RTDB anime write failed";
      console.warn("Firebase RTDB anime write warning:", err);
    }

    const path = `anime/${anime.id}`;
    try {
      const animeRef = doc(firestoreDb, "anime", anime.id);
      const mutableFields: Record<string, any> = {
        title: anime.title.slice(0, 200),
        titleJapanese: (anime.titleJapanese || "").slice(0, 200),
        synopsis: safeSynopsis,
        posterImage: (anime.posterImage || "").slice(0, 500000),
        bannerImage: (anime.bannerImage || anime.posterImage || "").slice(0, 500000),
        genres: (anime.genres || []).slice(0, 20),
        rating: cleanRating,
        ...(typeof anime.ratingVerified === "boolean" ? { ratingVerified: anime.ratingVerified } : {}),
        status: anime.status,
        year: Math.round(Number(anime.year) || new Date().getFullYear()),
        seasons: Math.max(1, Math.round(Number(anime.seasons) || 1)),
        episodesCount: normalizedCount,
        isPublished: Boolean(anime.isPublished),
        featured: Boolean(anime.featured),
        streamingSources: (anime.streamingSources || []).slice(0, 15),
        updatedAt: serverTimestamp(),
      };

      if (isNew) {
        await withTimeoutStrict(
          setDoc(animeRef, {
            id: anime.id,
            ...mutableFields,
            createdAt: serverTimestamp(),
          }),
          9000,
          "Firestore anime create"
        );
      } else {
        try {
          await withTimeoutStrict(
            updateDoc(animeRef, mutableFields),
            9000,
            "Firestore anime update"
          );
        } catch (updateErr: any) {
          if (updateErr?.code === "not-found") {
            await withTimeoutStrict(
              setDoc(animeRef, {
                id: anime.id,
                ...mutableFields,
                createdAt: serverTimestamp(),
              }),
              9000,
              "Firestore anime create-fallback"
            );
          } else {
            throw updateErr;
          }
        }
      }
      firestoreSaved = true;
    } catch (error: any) {
      lastError = error?.message || lastError || "Firestore anime write failed";
      if (error?.code === "permission-denied") {
        handleFirestoreError(
          error,
          isNew ? OperationType.CREATE : OperationType.UPDATE,
          path
        );
      }
      console.warn("Firestore anime write warning:", error);
    }
  }

  return { rtdbSaved, firestoreSaved, ...(lastError ? { error: lastError } : {}) };
}

/**
 * Deletes an anime and its episodes from Firebase Realtime Database and Firestore.
 */
export async function deleteAnimeFromFirebase(animeId: string): Promise<void> {
  if (isFirebaseVerifiedAdmin()) {
    try {
      await withTimeoutStrict(rtdbRemove(rtdbRef(rtdb, `anime/${animeId}`)), 6000, "RTDB anime delete");
      await withTimeoutStrict(
        rtdbSet(rtdbRef(rtdb, `deletedAnimeIds/${animeId}`), {
          animeId,
          deletedAt: new Date().toISOString(),
        }),
        6000,
        "RTDB tombstones"
      );

      const epsSnap = await withTimeoutStrict(rtdbGet(rtdbRef(rtdb, "episodes")), 6000, "RTDB episodes list");
      if (epsSnap && epsSnap.exists()) {
        const allEps = epsSnap.val() || {};
        const removals = Object.entries(allEps)
          .filter(([, ep]: [string, any]) => ep?.animeId === animeId)
          .map(([epKey]) => rtdbRemove(rtdbRef(rtdb, `episodes/${epKey}`)));
        if (removals.length > 0) {
          await withTimeoutStrict(Promise.all(removals), 8000, "RTDB episodes delete");
        }
      }
    } catch (err) {
      console.warn("Firebase RTDB anime delete warning:", err);
    }
  }

  if (isFirebaseVerifiedAdmin()) {
    const path = `anime/${animeId}`;
    try {
      await deleteDoc(doc(firestoreDb, "anime", animeId));
      await setDoc(doc(firestoreDb, "deletedAnime", animeId), {
        animeId,
        deletedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  }
}

async function ensureFirestoreParentAnime(animeId: string, parentAnime?: Anime) {
  if (!parentAnime) return;
  const parentRef = doc(firestoreDb, "anime", animeId);
  const snap = await withTimeoutStrict(getDoc(parentRef), 7500, "Firestore parent anime lookup");
  if (!snap.exists()) {
    const safeSynopsis =
      String(parentAnime.synopsis || "").trim().slice(0, 5000) ||
      `Stream ${parentAnime.title} in high speed on YG Flash Anime.`.slice(0, 5000);
    await withTimeoutStrict(
      setDoc(parentRef, {
        id: parentAnime.id,
        title: parentAnime.title.slice(0, 200),
        titleJapanese: (parentAnime.titleJapanese || "").slice(0, 200),
        synopsis: safeSynopsis,
        posterImage: (parentAnime.posterImage || "").slice(0, 500000),
        bannerImage: (parentAnime.bannerImage || parentAnime.posterImage || "").slice(0, 500000),
        genres: (parentAnime.genres || []).slice(0, 20),
        rating: String(parentAnime.rating || "13+").trim().slice(0, 32) || "13+",
        ...(typeof parentAnime.ratingVerified === "boolean"
          ? { ratingVerified: parentAnime.ratingVerified }
          : {}),
        status: parentAnime.status === "Completed" ? "Completed" : "Ongoing",
        year: Math.round(Number(parentAnime.year) || new Date().getFullYear()),
        seasons: Math.max(1, Math.round(Number(parentAnime.seasons) || 1)),
        episodesCount: normalizeEpisodesCount(parentAnime.episodesCount, 0),
        isPublished: Boolean(parentAnime.isPublished),
        featured: Boolean(parentAnime.featured),
        streamingSources: (parentAnime.streamingSources || []).slice(0, 15),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
      8500,
      "Firestore parent anime create"
    );
  }
}

/**
 * Saves or updates an episode in Firebase Realtime Database and Firestore.
 */
export async function saveEpisodeToFirebase(
  episode: Episode,
  isPublished = true,
  isNew = true,
  parentAnime?: Anime
): Promise<{ rtdbSaved: boolean; firestoreSaved: boolean; error?: string }> {
  let rtdbSaved = false;
  let firestoreSaved = false;
  let lastError = "";

  const lang = normalizeLanguage(episode.language);
  const desc = String(episode.description ?? episode.synopsis ?? "");
  const epNum = Math.max(0, Math.min(10000, Math.round(Number(episode.number) || 0)));
  const epOrder = Math.max(0, Math.round(episode.order ?? epNum));
  const nowIso = new Date().toISOString();

  const rtdbPayload = {
    id: episode.id,
    animeId: episode.animeId,
    number: epNum,
    season: Math.max(1, Number(episode.season) || 1),
    title: episode.title,
    language: lang,
    synopsis: desc,
    description: desc,
    duration: episode.duration || "24m",
    videoUrl: episode.videoUrl,
    thumbnailUrl: episode.thumbnailUrl || "",
    order: epOrder,
    sources: episode.sources || [],
    isPublished,
    createdAt: episode.createdAt || nowIso,
    updatedAt: episode.updatedAt || nowIso,
  };

  if (isFirebaseVerifiedAdmin()) {
    try {
      await withTimeoutStrict(
        rtdbSet(rtdbRef(rtdb, `episodes/${episode.id}`), rtdbPayload),
        8500,
        "RTDB episode save"
      );
      rtdbSaved = true;
    } catch (err: any) {
      lastError = err?.message || "RTDB episode write failed";
      console.warn("Firebase RTDB episode write warning:", err);
    }

    const path = `anime/${episode.animeId}/episodes/${episode.id}`;
    try {
      await ensureFirestoreParentAnime(episode.animeId, parentAnime);
      const epRef = doc(firestoreDb, "anime", episode.animeId, "episodes", episode.id);
      const baseFields: Record<string, any> = {
        number: epNum,
        season: Math.max(1, Math.round(Number(episode.season) || 1)),
        title: episode.title.slice(0, 200),
        language: lang,
        synopsis: desc.slice(0, 2000),
        description: desc.slice(0, 2000),
        duration: (episode.duration || "24m").slice(0, 32),
        videoUrl: episode.videoUrl.slice(0, 2048),
        thumbnailUrl: (episode.thumbnailUrl || "").slice(0, 500000),
        order: epOrder,
        sources: (episode.sources || []).slice(0, 15),
        isPublished: Boolean(isPublished),
        updatedAt: serverTimestamp(),
      };

      if (isNew) {
        await withTimeoutStrict(
          setDoc(epRef, {
            id: episode.id,
            animeId: episode.animeId,
            ...baseFields,
            createdAt: serverTimestamp(),
          }),
          9000,
          "Firestore episode create"
        );
      } else {
        try {
          await withTimeoutStrict(
            updateDoc(epRef, baseFields),
            9000,
            "Firestore episode update"
          );
        } catch (updateErr: any) {
          if (updateErr?.code === "not-found") {
            await withTimeoutStrict(
              setDoc(epRef, {
                id: episode.id,
                animeId: episode.animeId,
                ...baseFields,
                createdAt: serverTimestamp(),
              }),
              9000,
              "Firestore episode create-fallback"
            );
          } else {
            throw updateErr;
          }
        }
      }
      firestoreSaved = true;
    } catch (error: any) {
      lastError = error?.message || lastError || "Firestore episode write failed";
      if (error?.code === "permission-denied") {
        handleFirestoreError(
          error,
          isNew ? OperationType.CREATE : OperationType.UPDATE,
          path
        );
      }
      console.warn("Firestore episode write warning:", error);
    }
  }

  return { rtdbSaved, firestoreSaved, ...(lastError ? { error: lastError } : {}) };
}

/**
 * Saves multiple episodes in bounded batches (5 at a time) to Firebase RTDB & Firestore
 * so slow mobile networks never drop concurrent writes or lose episodes.
 */
export async function saveBulkEpisodesToFirebase(
  episodes: Episode[],
  isPublished = true,
  parentAnime?: Anime
): Promise<{ rtdbSavedCount: number; firestoreSavedCount: number }> {
  if (episodes.length === 0) return { rtdbSavedCount: 0, firestoreSavedCount: 0 };
  if (isFirebaseVerifiedAdmin() && parentAnime) {
    await ensureFirestoreParentAnime(parentAnime.id, parentAnime).catch((err) => {
      console.warn("Ensure parent anime before bulk warning:", err);
    });
  }

  let rtdbSavedCount = 0;
  let firestoreSavedCount = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < episodes.length; i += BATCH_SIZE) {
    const chunk = episodes.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      chunk.map((ep) => saveEpisodeToFirebase(ep, isPublished, true))
    );
    for (const r of results) {
      if (r.rtdbSaved) rtdbSavedCount += 1;
      if (r.firestoreSaved) firestoreSavedCount += 1;
    }
  }

  return { rtdbSavedCount, firestoreSavedCount };
}

/**
 * Persists reordered episodes in Firebase RTDB & Firestore.
 */
export async function reorderEpisodesInFirebase(
  animeId: string,
  orderedEpisodes: Episode[],
  isPublished = true
): Promise<void> {
  if (orderedEpisodes.length === 0) return;
  await Promise.all(
    orderedEpisodes.map((ep, idx) =>
      saveEpisodeToFirebase(
        {
          ...ep,
          animeId,
          order: idx + 1,
          updatedAt: new Date().toISOString(),
        },
        isPublished,
        false
      ).catch(() => {})
    )
  );
}

/**
 * Propagates an anime's publish visibility flag to ALL of its existing episodes in RTDB & Firestore
 * so previously saved episodes never stay hidden when an anime is published.
 */
export async function syncAnimePublishToEpisodesInFirebase(
  animeId: string,
  isPublished: boolean
): Promise<void> {
  const nextPub = Boolean(isPublished);
  const nowIso = new Date().toISOString();

  try {
    const epsSnap = await withTimeout(rtdbGet(rtdbRef(rtdb, "episodes")), 2500);
    if (epsSnap && epsSnap.exists()) {
      const allEps = epsSnap.val() || {};
      const updates = Object.entries(allEps)
        .filter(([, ep]: [string, any]) => ep?.animeId === animeId)
        .map(([epKey]) =>
          rtdbUpdate(rtdbRef(rtdb, `episodes/${epKey}`), {
            isPublished: nextPub,
            updatedAt: nowIso,
          })
        );
      if (updates.length > 0) {
        await withTimeout(Promise.all(updates), 3000);
      }
    }
  } catch (err) {
    console.warn("Firebase RTDB publish propagation warning:", err);
  }

  if (isFirebaseVerifiedAdmin()) {
    try {
      const snap = await withTimeout(
        getDocs(collection(firestoreDb, "anime", animeId, "episodes")),
        4500
      );
      if (snap && !snap.empty) {
        await Promise.all(
          snap.docs.map((epDoc) =>
            updateDoc(epDoc.ref, {
              isPublished: nextPub,
              updatedAt: serverTimestamp(),
            }).catch(() => {})
          )
        );
      }
    } catch (err) {
      console.warn("Firestore publish propagation warning:", err);
    }
  }
}

/**
 * Deletes an episode from Firebase Realtime Database and Firestore.
 */
export async function deleteEpisodeFromFirebase(
  animeId: string,
  episodeId: string
): Promise<void> {
  try {
    await withTimeout(rtdbRemove(rtdbRef(rtdb, `episodes/${episodeId}`)), 4500);
  } catch (err) {
    console.warn("Firebase RTDB episode delete warning:", err);
  }

  if (isFirebaseVerifiedAdmin()) {
    const path = `anime/${animeId}/episodes/${episodeId}`;
    try {
      await deleteDoc(doc(firestoreDb, "anime", animeId, "episodes", episodeId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  }
}

/**
 * Subscribes to realtime catalog updates from Firebase Realtime Database (onValue)
 * and Firestore (onSnapshot) so all users automatically receive new anime/movies.
 */
export function subscribeToRealtimeCatalog(
  includeUnpublished: boolean,
  onCatalogUpdate: (items: Anime[], deletedIds: string[]) => void
): () => void {
  let rtdbItems: Anime[] = [];
  let firestoreItems: Anime[] = [];
  let rtdbDeleted: string[] = [];
  let firestoreDeleted: string[] = [];

  const emitMerged = () => {
    const deletedSet = new Set([...rtdbDeleted, ...firestoreDeleted]);
    const map = new Map<string, Anime>();
    for (const item of firestoreItems) {
      if (item.id && !deletedSet.has(item.id)) {
        map.set(item.id, item);
      }
    }
    for (const item of rtdbItems) {
      if (item.id && !deletedSet.has(item.id)) {
        map.set(item.id, item);
      }
    }
    const merged = Array.from(map.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    onCatalogUpdate(merged, Array.from(deletedSet));
  };

  const unsubRtdbAnime = onValue(
    rtdbRef(rtdb, "anime"),
    (snapshot) => {
      const val = snapshot.val();
      if (val && typeof val === "object") {
        rtdbItems = Object.entries(val).map(([key, item]) =>
          normalizeAnimeRecord(item, key)
        );
      } else {
        rtdbItems = [];
      }
      emitMerged();
    },
    (error) => {
      console.warn("RTDB anime listener notice:", error?.message || error);
    }
  );

  const unsubRtdbDeleted = onValue(
    rtdbRef(rtdb, "deletedAnimeIds"),
    (snapshot) => {
      const val = snapshot.val();
      rtdbDeleted = val && typeof val === "object" ? Object.keys(val) : [];
      emitMerged();
    },
    () => {}
  );

  const animeQuery =
    includeUnpublished && isFirebaseVerifiedAdmin()
      ? collection(firestoreDb, "anime")
      : query(collection(firestoreDb, "anime"), where("isPublished", "==", true));

  const unsubFirestoreAnime = onSnapshot(
    animeQuery,
    (snapshot) => {
      firestoreItems = snapshot.docs.map((d) =>
        normalizeAnimeRecord(d.data(), d.id)
      );
      emitMerged();
    },
    (error) => {
      if (error?.code === "permission-denied") {
        handleFirestoreError(error, OperationType.LIST, "anime");
      }
    }
  );

  const unsubFirestoreDeleted = onSnapshot(
    collection(firestoreDb, "deletedAnime"),
    (snapshot) => {
      firestoreDeleted = snapshot.docs.map((d) => d.id);
      emitMerged();
    },
    () => {}
  );

  return () => {
    unsubRtdbAnime();
    unsubRtdbDeleted();
    unsubFirestoreAnime();
    unsubFirestoreDeleted();
  };
}

/**
 * Subscribes to realtime episode updates for a specific anime from Firebase RTDB & Firestore.
 */
export function subscribeToAnimeEpisodes(
  animeId: string,
  includeUnpublished: boolean,
  onEpisodesUpdate: (episodes: Episode[], meta?: { hasSnapshot: boolean }) => void
): () => void {
  let rtdbEps: Episode[] = [];
  let firestoreEps: Episode[] = [];
  let hasRtdb = false;
  let hasFirestore = false;

  const emitMerged = () => {
    const map = new Map<string, Episode>();
    for (const ep of firestoreEps) {
      if (ep.id) map.set(ep.id, mergeEpisodeRecords(map.get(ep.id), ep));
    }
    for (const ep of rtdbEps) {
      if (ep.id) map.set(ep.id, mergeEpisodeRecords(map.get(ep.id), ep));
    }
    const sorted = sortEpisodes(Array.from(map.values()));
    onEpisodesUpdate(sorted, { hasSnapshot: hasRtdb || hasFirestore });
  };

  const unsubRtdb = onValue(
    rtdbRef(rtdb, "episodes"),
    (snapshot) => {
      hasRtdb = true;
      const val = snapshot.val();
      if (val && typeof val === "object") {
        rtdbEps = Object.entries(val)
          .map(([key, item]) => normalizeEpisodeRecord(item, key))
          .filter((ep) => ep.animeId === animeId && (includeUnpublished || ep.isPublished !== false));
      } else {
        rtdbEps = [];
      }
      emitMerged();
    },
    () => {}
  );

  const epCollectionPath = `anime/${animeId}/episodes`;
  const epQuery =
    includeUnpublished && isFirebaseVerifiedAdmin()
      ? collection(firestoreDb, "anime", animeId, "episodes")
      : query(
          collection(firestoreDb, "anime", animeId, "episodes"),
          where("isPublished", "==", true)
        );

  const unsubFirestore = onSnapshot(
    epQuery,
    (snapshot) => {
      hasFirestore = true;
      firestoreEps = snapshot.docs.map((d) =>
        normalizeEpisodeRecord(d.data(), d.id)
      );
      emitMerged();
    },
    (error) => {
      if (error?.code === "permission-denied") {
        handleFirestoreError(error, OperationType.LIST, epCollectionPath);
      }
    }
  );

  return () => {
    unsubRtdb();
    unsubFirestore();
  };
}

/**
 * Performs a one-shot parallel fetch of episodes from Firestore and RTDB
 * so playback resumption and episode management work seamlessly even when Express JSON cache is empty.
 */
export async function fetchAnimeEpisodesOnce(
  animeId: string,
  includeUnpublished: boolean
): Promise<Episode[]> {
  if (!animeId) return [];
  const canReadUnpublished = includeUnpublished && isFirebaseVerifiedAdmin();

  const rtdbPromise = withTimeout(
    rtdbGet(rtdbRef(rtdb, "episodes"))
      .then((snap) => {
        const val = snap.val();
        if (!val || typeof val !== "object") return [] as Episode[];
        return Object.entries(val)
          .map(([key, item]) => normalizeEpisodeRecord(item, key))
          .filter((ep) => ep.animeId === animeId && (includeUnpublished || ep.isPublished !== false));
      })
      .catch(() => [] as Episode[]),
    8500
  );

  const epQuery = canReadUnpublished
    ? collection(firestoreDb, "anime", animeId, "episodes")
    : query(collection(firestoreDb, "anime", animeId, "episodes"), where("isPublished", "==", true));

  const fsPromise = withTimeout(
    getDocs(epQuery)
      .then((snap) => snap.docs.map((d) => normalizeEpisodeRecord(d.data(), d.id)))
      .catch(() => [] as Episode[]),
    8500
  );

  const [rtdbEps, fsEps] = await Promise.all([rtdbPromise, fsPromise]);
  return mergeEpisodeLists(fsEps || [], rtdbEps || []);
}

/**
 * Syncs any server-cached anime and episodes into permanent Firebase RTDB & Firestore
 * once the owner connects verified Google Firebase Admin authentication.
 */
export async function syncLocalCatalogAndEpisodesToFirebase(
  animeList: Anime[],
  adminHeaderToken?: string
): Promise<{ animeSynced: number; episodesSynced: number }> {
  if (!isFirebaseVerifiedAdmin() || animeList.length === 0) {
    return { animeSynced: 0, episodesSynced: 0 };
  }

  let animeSynced = 0;
  let episodesSynced = 0;
  const headers: Record<string, string> = {};
  if (adminHeaderToken && adminHeaderToken !== "cookie-session") {
    headers.Authorization = `Bearer ${adminHeaderToken}`;
  }

  for (const anime of animeList) {
    try {
      const aRes = await saveAnimeToFirebase(anime, false);
      if (aRes.rtdbSaved || aRes.firestoreSaved) {
        animeSynced += 1;
      }
      const res = await fetch(apiUrl(`/api/anime/${anime.id}`), {
        credentials: "include",
        headers,
      }).catch(() => null);
      if (res?.ok) {
        const data = await res.json().catch(() => null);
        const serverEps: Episode[] = Array.isArray(data?.episodes) ? data.episodes : [];
        if (serverEps.length > 0) {
          const epRes = await saveBulkEpisodesToFirebase(
            serverEps,
            anime.isPublished,
            anime
          );
          episodesSynced += Math.max(epRes.rtdbSavedCount, epRes.firestoreSavedCount);
        }
      }
    } catch (err) {
      console.warn("Cloud sync item warning:", anime.id, err);
    }
  }

  return { animeSynced, episodesSynced };
}

// ==================== USER PROFILE & WATCH HISTORY REALTIME SYNC ====================

export interface FirebaseUserProfileData {
  uid: string;
  displayName: string;
  profilePicture?: string;
  themeMode: ThemeMode;
  colorTheme: ThemeType;
  backgroundPoster?: BackgroundPoster;
  safeMode: boolean;
  soundEnabled?: boolean;
  soundPack?: SoundPack;
  favorites: string[];
  watchlist: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Subscribes to authenticated user profile updates in Firestore & RTDB.
 * Safe no-op when called without matching verified Firebase Auth user.
 */
export function subscribeToUserProfile(
  uid: string,
  onProfileUpdate: (profile: Partial<FirebaseUserProfileData> | null) => void
): () => void {
  if (!uid || !isFirebaseOwner(uid)) {
    return () => {};
  }

  let fsProfile: Partial<FirebaseUserProfileData> | null = null;
  let rtdbProfile: Partial<FirebaseUserProfileData> | null = null;

  const emitMerged = () => {
    if (!fsProfile && !rtdbProfile) {
      onProfileUpdate(null);
      return;
    }
    const merged: Partial<FirebaseUserProfileData> = {
      ...(rtdbProfile || {}),
      ...(fsProfile || {}),
    };
    onProfileUpdate(merged);
  };

  const userDocPath = `users/${uid}`;
  const unsubFs = onSnapshot(
    doc(firestoreDb, "users", uid),
    (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        fsProfile = {
          uid,
          ...(typeof d.displayName === "string" && d.displayName.trim()
            ? { displayName: d.displayName.trim() }
            : {}),
          ...(typeof d.profilePicture === "string" ? { profilePicture: d.profilePicture } : {}),
          ...(d.themeMode ? { themeMode: d.themeMode } : {}),
          ...(d.colorTheme ? { colorTheme: d.colorTheme } : {}),
          ...(d.backgroundPoster ? { backgroundPoster: d.backgroundPoster } : {}),
          ...(typeof d.safeMode === "boolean" ? { safeMode: d.safeMode } : {}),
          ...(typeof d.soundEnabled === "boolean" ? { soundEnabled: d.soundEnabled } : {}),
          ...(d.soundPack ? { soundPack: d.soundPack } : {}),
          ...(Array.isArray(d.favorites) ? { favorites: dedupeIdList(d.favorites) } : {}),
          ...(Array.isArray(d.watchlist) ? { watchlist: dedupeIdList(d.watchlist) } : {}),
          updatedAt: normalizeTimestamp(d.updatedAt),
        };
      } else {
        fsProfile = null;
      }
      emitMerged();
    },
    (error) => {
      if (error?.code === "permission-denied") {
        handleFirestoreError(error, OperationType.GET, userDocPath);
      }
    }
  );

  const unsubRtdb = onValue(
    rtdbRef(rtdb, `users/${uid}/profile`),
    (snap) => {
      const val = snap.val();
      rtdbProfile = val && typeof val === "object" ? val : null;
      emitMerged();
    },
    () => {}
  );

  return () => {
    unsubFs();
    unsubRtdb();
  };
}

/**
 * Persists authenticated user profile fields to Firestore & RTDB without overwriting missing fields.
 */
export async function saveUserProfileToFirebase(
  uid: string,
  partial: Partial<FirebaseUserProfileData>,
  defaults: Omit<FirebaseUserProfileData, "uid">
): Promise<void> {
  if (!uid || !isFirebaseOwner(uid)) return;

  const normalizedPartialColorTheme =
    partial.colorTheme !== undefined
      ? (partial.colorTheme as string) === "crimson"
        ? "emerald"
        : partial.colorTheme
      : undefined;

  try {
    const cleanRtdb: Record<string, any> = {
      uid,
      ...partial,
      ...(normalizedPartialColorTheme !== undefined
        ? { colorTheme: normalizedPartialColorTheme }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await withTimeout(rtdbUpdate(rtdbRef(rtdb, `users/${uid}/profile`), cleanRtdb), 2500);
  } catch {}

  const path = `users/${uid}`;
  const docRef = doc(firestoreDb, "users", uid);
  try {
    const existing = await withTimeout(getDoc(docRef), 3500);
    if (existing && existing.exists()) {
      const updates: Record<string, any> = { updatedAt: serverTimestamp() };
      if (partial.displayName !== undefined) {
        updates.displayName = String(partial.displayName).trim().slice(0, 32) || defaults.displayName;
      }
      if (partial.profilePicture !== undefined) {
        updates.profilePicture = String(partial.profilePicture || "").slice(0, 500000);
      }
      if (partial.themeMode !== undefined) updates.themeMode = partial.themeMode;
      if (normalizedPartialColorTheme !== undefined) updates.colorTheme = normalizedPartialColorTheme;
      if (partial.backgroundPoster !== undefined) updates.backgroundPoster = partial.backgroundPoster;
      if (typeof partial.safeMode === "boolean") updates.safeMode = partial.safeMode;
      if (typeof partial.soundEnabled === "boolean") updates.soundEnabled = partial.soundEnabled;
      if (partial.soundPack !== undefined) updates.soundPack = partial.soundPack;
        if (Array.isArray(partial.favorites)) updates.favorites = dedupeIdList(partial.favorites, 200);
      if (Array.isArray(partial.watchlist)) updates.watchlist = dedupeIdList(partial.watchlist, 200);
      await withTimeout(updateDoc(docRef, updates), 4000);
    } else {
      const merged = { ...defaults, ...partial };
      await withTimeout(
        setDoc(docRef, {
          uid,
          displayName: String(merged.displayName || "Otaku Explorer").trim().slice(0, 32),
          profilePicture: String(merged.profilePicture || "").slice(0, 500000),
          themeMode: merged.themeMode || "dark",
          colorTheme:
            merged.colorTheme && merged.colorTheme !== ("crimson" as any)
              ? merged.colorTheme
              : "emerald",
          backgroundPoster: merged.backgroundPoster || "rengoku",
          safeMode: Boolean(merged.safeMode),
          soundEnabled: merged.soundEnabled !== false,
          soundPack: merged.soundPack || "cyber",
          favorites: dedupeIdList(merged.favorites, 200),
          watchlist: dedupeIdList(merged.watchlist, 200),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        4000
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeToUserWatchHistory(
  uid: string,
  onHistoryUpdate: (items: HistoryItem[], meta?: { fromCache: boolean }) => void
): () => void {
  if (!uid || !isFirebaseOwner(uid)) {
    return () => {};
  }

  const colPath = `users/${uid}/watchHistory`;
  const q = query(
    collection(firestoreDb, "users", uid, "watchHistory"),
    where("uid", "==", uid)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const rawItems: HistoryItem[] = snapshot.docs
        .map((d) => {
          const raw = d.data();
          return {
            animeId: String(raw.animeId || ""),
            animeTitle: String(raw.animeTitle || ""),
            episodeId: String(raw.episodeId || ""),
            episodeNumber: Number(raw.episodeNumber) || 1,
            episodeTitle: String(raw.episodeTitle || `Episode ${raw.episodeNumber || 1}`),
            season: typeof raw.season === "number" ? raw.season : 1,
            language: typeof raw.language === "string" ? raw.language : "Japanese",
            poster: String(raw.poster || ""),
            progressSeconds: Number(raw.progressSeconds) || 0,
            durationSeconds: Number(raw.durationSeconds) || 0,
            updatedAt: normalizeTimestampMillis(raw.updatedAt),
          };
        })
        .filter((h) => Boolean(h.animeId && h.episodeId));

      onHistoryUpdate(dedupeWatchHistoryByAnime(rawItems, 30), {
        fromCache: snapshot.metadata.fromCache,
      });
    },
    (error) => {
      if (error?.code === "permission-denied") {
        handleFirestoreError(error, OperationType.LIST, colPath);
      }
    }
  );
}

export async function saveWatchHistoryToFirebase(
  uid: string,
  item: Omit<HistoryItem, "updatedAt">,
  profileDefaults?: Omit<FirebaseUserProfileData, "uid">
): Promise<void> {
  if (!uid || !isFirebaseOwner(uid)) return;
  const safeAnimeId = item.animeId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  // Canonical single doc per animeId so switching episodes cleanly replaces the old Continuing Watching entry
  const historyId = `anime_${safeAnimeId}`.slice(0, 128);
  const path = `users/${uid}/watchHistory/${historyId}`;

  try {
    // Ensure parent user document exists because watchHistory create rule verifies exists(/users/uid)
    const userDocRef = doc(firestoreDb, "users", uid);
    const userSnap = await withTimeout(getDoc(userDocRef), 2500);
    if (userSnap && !userSnap.exists() && profileDefaults) {
      await saveUserProfileToFirebase(uid, {}, profileDefaults);
    }

    await withTimeout(
      setDoc(doc(firestoreDb, "users", uid, "watchHistory", historyId), {
        id: historyId,
        uid,
        animeId: item.animeId,
        animeTitle: String(item.animeTitle || "Anime").slice(0, 200),
        episodeId: item.episodeId.slice(0, 128),
        episodeNumber: Math.max(0, Math.min(10000, Math.round(item.episodeNumber || 1))),
        episodeTitle: String(item.episodeTitle || `Episode ${item.episodeNumber || 1}`).slice(0, 200),
        season: Math.max(1, Math.min(200, Math.round(item.season || 1))),
        language: String(item.language || "Japanese").slice(0, 40),
        poster: String(item.poster || "").slice(0, 500000),
        progressSeconds: Math.max(0, Number(item.progressSeconds) || 0),
        durationSeconds: Math.max(0, Number(item.durationSeconds) || 0),
        updatedAt: serverTimestamp(),
      }),
      4000
    );

    // Background cleanup of any legacy per-episode duplicate docs for this animeId
    try {
      const legacyQuery = query(
        collection(firestoreDb, "users", uid, "watchHistory"),
        where("uid", "==", uid),
        where("animeId", "==", item.animeId)
      );
      const legacySnap = await withTimeout(getDocs(legacyQuery), 2500);
      if (legacySnap && !legacySnap.empty) {
        const staleDocs = legacySnap.docs.filter((d) => d.id !== historyId);
        if (staleDocs.length > 0) {
          await Promise.all(staleDocs.map((d) => deleteDoc(d.ref).catch(() => {})));
        }
      }
    } catch {}
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function clearWatchHistoryInFirebase(uid: string): Promise<void> {
  if (!uid || !isFirebaseOwner(uid)) return;
  const path = `users/${uid}/watchHistory`;
  try {
    const q = query(
      collection(firestoreDb, "users", uid, "watchHistory"),
      where("uid", "==", uid)
    );
    const snap = await withTimeout(getDocs(q), 4000);
    if (snap && !snap.empty) {
      await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
