import type { Episode, HistoryItem } from "../context/AppContext";

const STORAGE_KEY = "yg_ep_snapshot_cache_v1";
const MAX_CACHED_ANIME = 30;
const memoryCache = new Map<string, Episode[]>();

interface StoredCachePayload {
  order: string[];
  byAnime: Record<string, Episode[]>;
}

function readStoredCache(): StoredCachePayload {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { order: [], byAnime: {} };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.byAnime && Array.isArray(parsed.order)) {
      return parsed as StoredCachePayload;
    }
  } catch {}
  return { order: [], byAnime: {} };
}

function writeStoredCache(payload: StoredCachePayload): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

function hasPlayableSource(ep: Episode | undefined | null): boolean {
  if (!ep) return false;
  if (ep.videoUrl && ep.videoUrl.trim().length > 0) return true;
  return Array.isArray(ep.sources) && ep.sources.some((s) => Boolean(s?.url?.trim()));
}

export function cacheAnimeEpisodes(animeId: string, episodes: Episode[]): void {
  if (!animeId || !Array.isArray(episodes) || episodes.length === 0) return;
  memoryCache.set(animeId, episodes);

  const payload = readStoredCache();
  payload.byAnime[animeId] = episodes.slice(0, 120);
  payload.order = [animeId, ...payload.order.filter((id) => id !== animeId)];
  while (payload.order.length > MAX_CACHED_ANIME) {
    const evicted = payload.order.pop();
    if (evicted) delete payload.byAnime[evicted];
  }
  writeStoredCache(payload);
}

export function upsertCachedEpisode(animeId: string, episode: Episode): void {
  if (!animeId || !episode?.id || !hasPlayableSource(episode)) return;
  const existing = getCachedAnimeEpisodes(animeId);
  const next = [episode, ...existing.filter((e) => e.id !== episode.id)];
  cacheAnimeEpisodes(animeId, next);
}

export function getCachedAnimeEpisodes(animeId: string): Episode[] {
  if (!animeId) return [];
  const inMem = memoryCache.get(animeId);
  if (inMem && inMem.length > 0) return inMem;

  const stored = readStoredCache().byAnime[animeId];
  if (Array.isArray(stored) && stored.length > 0) {
    memoryCache.set(animeId, stored);
    return stored;
  }
  return [];
}

export function matchResumeEpisode(
  episodes: Episode[],
  saved: Pick<HistoryItem, "episodeId" | "episodeNumber" | "season" | "language">
): Episode | undefined {
  if (!Array.isArray(episodes) || episodes.length === 0) return undefined;
  const targetSeason = saved.season || 1;
  return (
    episodes.find((e) => e.id === saved.episodeId) ||
    episodes.find(
      (e) =>
        e.number === saved.episodeNumber &&
        (e.season || 1) === targetSeason &&
        (!saved.language || !e.language || e.language === saved.language)
    ) ||
    episodes.find((e) => e.number === saved.episodeNumber && (e.season || 1) === targetSeason) ||
    episodes.find((e) => e.number === saved.episodeNumber)
  );
}

export function findCachedEpisodeForResume(
  animeId: string,
  saved: Pick<HistoryItem, "episodeId" | "episodeNumber" | "season" | "language">
): Episode | undefined {
  const cached = getCachedAnimeEpisodes(animeId);
  const matched = matchResumeEpisode(cached, saved);
  return hasPlayableSource(matched) ? matched : undefined;
}
