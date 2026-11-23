export interface BaseHistoryEntry {
  animeId: string;
  episodeId: string;
  episodeNumber: number;
  progressSeconds: number;
  durationSeconds: number;
  updatedAt: number;
}

/**
 * Preserves insertion order while removing duplicate, blank, or non-string IDs.
 */
export function dedupeIdList(rawIds: unknown, limit = 200): string[] {
  if (!Array.isArray(rawIds)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawIds) {
    const id = typeof raw === "string" ? raw.trim() : String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Determines whether a history record represents an actively resumable episode
 * (at least 0.5s watched and not already finished within the final 2s).
 */
export function isActiveContinueWatchingItem(item: {
  progressSeconds: number;
  durationSeconds: number;
}): boolean {
  const progress = Number(item.progressSeconds) || 0;
  const duration = Number(item.durationSeconds) || 0;
  if (progress < 0.5) return false;
  if (duration > 0 && progress >= duration - 2) return false;
  return true;
}

/**
 * Enforces strict per-animeId uniqueness (at most ONE Continue Watching / History
 * entry per animeId), always retaining the newest timestamped record.
 */
export function dedupeWatchHistoryByAnime<T extends BaseHistoryEntry>(
  items: T[],
  limit = 30
): T[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const byAnime = new Map<string, T>();
  for (const item of items) {
    if (!item || !item.animeId || !item.episodeId) continue;
    const existing = byAnime.get(item.animeId);
    const incomingTs = Number(item.updatedAt) || 0;
    const existingTs = Number(existing?.updatedAt) || 0;
    if (!existing || incomingTs > existingTs) {
      byAnime.set(item.animeId, item);
    }
  }
  return Array.from(byAnime.values())
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, limit);
}

/**
 * Returns strictly deduplicated active Continue Watching entries matching valid catalog anime.
 */
export function getContinueWatchingItems<T extends BaseHistoryEntry>(
  items: T[],
  validAnimeIds?: Set<string>,
  limit = 4
): T[] {
  const deduped = dedupeWatchHistoryByAnime(items, 50);
  const active: T[] = [];
  for (const item of deduped) {
    if (validAnimeIds && !validAnimeIds.has(item.animeId)) continue;
    if (!isActiveContinueWatchingItem(item)) continue;
    active.push(item);
    if (active.length >= limit) break;
  }
  return active;
}

/**
 * Finds the active incomplete resume entry for a specific animeId if one exists.
 */
export function findActiveResumeForAnime<T extends BaseHistoryEntry>(
  items: T[],
  animeId: string
): T | undefined {
  if (!animeId) return undefined;
  const deduped = dedupeWatchHistoryByAnime(items, 50);
  const match = deduped.find((h) => h.animeId === animeId);
  if (!match) return undefined;
  return isActiveContinueWatchingItem(match) ? match : undefined;
}
