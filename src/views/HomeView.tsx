import React, { useMemo, useState } from "react";
import { Play, Info, ShieldCheck, Clock, Flame, Image as ImageIcon, ListCheck, Sparkles, TrendingUp } from "lucide-react";
import { useApp, BackgroundPoster } from "../context/AppContext";
import {
  dedupeIdList,
  findActiveResumeForAnime,
  getContinueWatchingItems,
  isActiveContinueWatchingItem,
  dedupeWatchHistoryByAnime,
} from "../utils/historyDedupe";

const POSTER_OPTIONS: { id: BackgroundPoster; label: string; thumb: string | null }[] = [
  { id: "rengoku", label: "Rengoku", thumb: "/assets/aistudio/45d41c027c9d9b08d7904e871fda8640_cb4c1154.jpg" },
  { id: "luffy", label: "Luffy", thumb: "/assets/aistudio/6b99f5ad24ea0e17150c200b8b8428b3_5b791649.jpg" },
  { id: "mikey", label: "Mikey", thumb: "/assets/aistudio/20c40a85225912e40b51a4b4c302cc00_90a378e3.jpg" },
  { id: "none", label: "Dark", thumb: null },
];

function formatResumeTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export const HomeView: React.FC = () => {
  const {
    catalog,
    isLoadingCatalog,
    navigateTo,
    resumeAnimePlayback,
    history,
    watchlist,
    safeMode,
    isAdmin,
    backgroundPoster,
    setBackgroundPoster,
  } = useApp();

  const catalogIdSet = useMemo(() => new Set(catalog.map((a) => a.id)), [catalog]);
  const watchlistSet = useMemo(() => new Set(dedupeIdList(watchlist)), [watchlist]);

  const watchlistAnime = useMemo(
    () => catalog.filter((a) => watchlistSet.has(a.id)),
    [catalog, watchlistSet]
  );

  const featured = useMemo(() => catalog.find((a) => a.featured) || catalog[0] || null, [catalog]);

  const featuredHistory = useMemo(
    () => (featured ? findActiveResumeForAnime(history, featured.id) : undefined),
    [featured, history]
  );

  const continueWatching = useMemo(
    () => getContinueWatchingItems(history, catalogIdSet, 4),
    [history, catalogIdSet]
  );

  const activeResumeByAnime = useMemo(() => {
    const map = new Map<string, (typeof history)[number]>();
    for (const item of dedupeWatchHistoryByAnime(history, 50)) {
      if (isActiveContinueWatchingItem(item)) {
        map.set(item.animeId, item);
      }
    }
    return map;
  }, [history]);

  const [selectedGenre, setSelectedGenre] = useState<string>("All");

  const availableGenres = useMemo(() => {
    const set = new Set<string>();
    for (const item of catalog) {
      if (Array.isArray(item.genres)) {
        for (const g of item.genres) {
          const clean = String(g || "").trim();
          if (clean) set.add(clean);
        }
      }
    }
    return ["All", ...Array.from(set).sort((a, b) => a.localeCompare(b)).slice(0, 12)];
  }, [catalog]);

  const trendingAnime = useMemo(() => {
    const explicitlyTrending = catalog.filter((a) => a.trending);
    if (explicitlyTrending.length > 0) return explicitlyTrending.slice(0, 6);
    const seen = new Set<string>();
    return [...catalog]
      .sort((a, b) => {
        const aScore = (a.featured ? 10 : 0) + (a.episodesCount || 0) * 0.1 + (a.year || 0) * 0.01;
        const bScore = (b.featured ? 10 : 0) + (b.episodesCount || 0) * 0.1 + (b.year || 0) * 0.01;
        return bScore - aScore;
      })
      .filter((a) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      })
      .slice(0, 6);
  }, [catalog]);

  const recentlyAddedAnime = useMemo(() => {
    return [...catalog]
      .sort((a, b) => {
        const tA = new Date(a.updatedAt || a.createdAt || 0).getTime() || 0;
        const tB = new Date(b.updatedAt || b.createdAt || 0).getTime() || 0;
        return tB - tA;
      })
      .slice(0, 5);
  }, [catalog]);

  const filteredCatalog = useMemo(() => {
    if (selectedGenre === "All") return catalog;
    const target = selectedGenre.toLowerCase();
    return catalog.filter((a) =>
      Array.isArray(a.genres) && a.genres.some((g) => String(g).trim().toLowerCase() === target)
    );
  }, [catalog, selectedGenre]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-4 md:py-6 space-y-8 pb-24">
      {/* Safe Mode Status Banner + Quick Backdrop Poster Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs text-[var(--text-muted)] border-b border-[var(--border-subtle)] pb-2.5">
        <div className="flex items-center gap-2">
          <span className="font-bold text-white tracking-wider text-[11px]">YG FLASH ANIME</span>
          <span aria-hidden="true">·</span>
          <span>Next-Gen Streaming</span>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Compact Anime Background Poster Switcher right in 1st section */}
          <div className="flex items-center gap-1.5 bg-[var(--bg-card)]/95 border border-[var(--border-subtle)] rounded-xl p-1">
            <span className="flex items-center gap-1 px-1.5 text-[10px] font-semibold text-[var(--text-muted)]">
              <ImageIcon className="w-3 h-3 text-[var(--primary)]" />
              <span className="hidden sm:inline">Backdrop</span>
            </span>
            {POSTER_OPTIONS.map((opt) => {
              const isSelected = backgroundPoster === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setBackgroundPoster(opt.id)}
                  className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-colors active:scale-95 ${
                    isSelected
                      ? "bg-[var(--primary)] text-white shadow-sm"
                      : "text-[var(--text-muted)] hover:text-white hover:bg-white/5"
                  }`}
                >
                  {opt.thumb && (
                    <img
                      src={opt.thumb}
                      alt={opt.label}
                      className="w-3.5 h-3.5 rounded object-cover"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 text-[11px]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Safe Mode {safeMode ? "Active" : "Off"}</span>
          </div>
        </div>
      </div>

      {/* Featured Anime Hero Split / Backdrop */}
      {featured ? (
        <div className="yg-dark-surface relative rounded-3xl overflow-hidden border border-[var(--border-subtle)] bg-[#09090b] min-h-[360px] md:min-h-[440px] flex items-end">
          {/* Backdrop Image */}
          <div className="absolute inset-0">
            <img
              src={featured.bannerImage || featured.posterImage}
              alt={featured.title}
              className="w-full h-full object-cover filter brightness-[0.55]"
              referrerPolicy="no-referrer"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#09090b] via-[#09090b]/65 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-[#09090b] via-transparent to-transparent hidden md:block" />
          </div>

          {/* Featured Content Info */}
          <div className="relative z-10 p-6 md:p-10 max-w-2xl space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--primary)] uppercase tracking-wider">
              <Flame className="w-4 h-4" />
              <span>Featured Spotlight</span>
            </div>

            <h1 className="text-2xl sm:text-4xl md:text-5xl font-black text-white tracking-tight leading-tight text-balance">
              {featured.title}
            </h1>

            {/* Unboxed Metadata */}
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] font-medium">
              <span className="text-white font-bold">{featured.rating}</span>
              <span aria-hidden="true">·</span>
              <span>{featured.year}</span>
              <span aria-hidden="true">·</span>
              <span>{featured.episodesCount} Episodes</span>
              <span aria-hidden="true">·</span>
              <span className="text-white">{(Array.isArray(featured.genres) ? featured.genres : []).slice(0, 2).join(", ") || "Anime"}</span>
            </div>

            <p className="text-xs sm:text-sm text-neutral-300 line-clamp-2 md:line-clamp-3 leading-relaxed">
              {featured.synopsis}
            </p>

            {/* CTA Buttons */}
            <div className="pt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  featuredHistory
                    ? resumeAnimePlayback(featured, featuredHistory)
                    : navigateTo("details", featured.id)
                }
                className="theme-btn-primary min-h-[44px] px-6 py-2.5 rounded-xl font-bold text-xs sm:text-sm flex items-center gap-2 shadow-lg active:scale-95 transition-transform"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>
                  {featuredHistory
                    ? `Resume Ep ${featuredHistory.episodeNumber} · ${formatResumeTime(featuredHistory.progressSeconds)}`
                    : "Watch Now"}
                </span>
              </button>

              <button
                type="button"
                onClick={() => navigateTo("details", featured.id)}
                className="min-h-[44px] px-4 py-2.5 rounded-xl bg-white/15 hover:bg-white/20 border border-white/15 text-white font-semibold text-xs sm:text-sm flex items-center gap-2 transition-colors active:scale-95"
              >
                <Info className="w-4 h-4" />
                <span>{featuredHistory ? "Episodes & Details" : "Details"}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Continue Watching Row (if history exists) */}
      {continueWatching.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--primary)]" />
              <span>Continue Watching</span>
            </h2>
            <button
              type="button"
              onClick={() => navigateTo("history")}
              className="text-xs text-[var(--primary)] font-medium hover:underline"
            >
              See all
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
            {continueWatching.map((item) => {
              const targetAnime = catalog.find((a) => a.id === item.animeId);
              const pct =
                item.durationSeconds > 0
                  ? Math.min(100, Math.round((item.progressSeconds / item.durationSeconds) * 100))
                  : 0;
              return (
                <div
                  key={item.animeId}
                  onClick={() =>
                    targetAnime
                      ? resumeAnimePlayback(targetAnime, item)
                      : navigateTo("details", item.animeId)
                  }
                  className="group cursor-pointer rounded-2xl overflow-hidden bg-[var(--bg-card)]/95 border border-[var(--border-subtle)] hover:border-[var(--primary)] shadow-lg shadow-black/40 transition-colors p-2.5 space-y-2 active:scale-95"
                >
                  <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-900">
                    <img
                      src={item.poster}
                      alt={item.animeTitle}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                      referrerPolicy="no-referrer"
                    />
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <div className="w-8 h-8 rounded-full bg-[var(--primary)] text-white flex items-center justify-center shadow-md">
                        <Play className="w-4 h-4 fill-current translate-x-0.5" />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigateTo("details", item.animeId);
                      }}
                      title="Open Episodes & Details"
                      aria-label="Open Episodes & Details"
                      className="absolute top-1.5 right-1.5 w-6 h-6 rounded-md bg-black/70 hover:bg-black text-white/80 hover:text-white flex items-center justify-center border border-white/15"
                    >
                      <Info className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white truncate">{item.animeTitle}</h4>
                    <p className="text-[10px] text-[var(--text-muted)] truncate">
                      Ep {item.episodeNumber} · {formatResumeTime(item.progressSeconds)}
                    </p>
                    <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden mt-1.5">
                      <div className="h-full bg-[var(--primary)]" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Watchlist Row (persisted to UID profile & Firestore) */}
      {watchlistAnime.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <ListCheck className="w-4 h-4 text-[var(--primary)]" />
              <span>My Watchlist ({watchlistAnime.length})</span>
            </h2>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {watchlistAnime.map((item) => (
              <div
                key={`wl-${item.id}`}
                onClick={() => navigateTo("details", item.id)}
                className="group cursor-pointer rounded-2xl overflow-hidden bg-[var(--bg-card)]/95 border border-[var(--border-subtle)] hover:border-[var(--primary)] transition-colors p-2 space-y-2 active:scale-95"
              >
                <div className="relative aspect-[3/4] rounded-xl overflow-hidden bg-neutral-900">
                  <img
                    src={item.posterImage}
                    alt={item.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute top-1.5 right-1.5 yg-dark-surface px-1.5 py-0.5 rounded bg-black/75 text-[9px] font-bold text-white">
                    {item.rating}
                  </div>
                </div>
                <p className="text-xs font-bold text-white truncate">{item.title}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trending Now Row */}
      {trendingAnime.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-[var(--primary)]" />
              <span>Trending Anime</span>
            </h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {trendingAnime.map((item, idx) => (
              <div
                key={`tr-${item.id}`}
                onClick={() => navigateTo("details", item.id)}
                className="group cursor-pointer rounded-2xl overflow-hidden bg-[var(--bg-card)]/95 border border-[var(--border-subtle)] hover:border-[var(--primary)] transition-colors p-2 space-y-2 active:scale-95"
              >
                <div className="relative aspect-[3/4] rounded-xl overflow-hidden bg-neutral-900">
                  <img
                    src={item.posterImage}
                    alt={item.title}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-[var(--primary)] text-[9px] font-black text-white shadow">
                    #{idx + 1}
                  </div>
                  <div className="absolute top-1.5 right-1.5 yg-dark-surface px-1.5 py-0.5 rounded bg-black/75 text-[9px] font-bold text-white">
                    {item.rating}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-bold text-white truncate group-hover:text-[var(--primary)] transition-colors">
                    {item.title}
                  </p>
                  <p className="text-[10px] text-[var(--text-muted)] truncate">
                    {item.year} · {item.episodesCount} Ep
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recently Added Row */}
      {recentlyAddedAnime.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[var(--primary)]" />
              <span>Recently Added</span>
            </h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 sm:gap-4">
            {recentlyAddedAnime.map((item) => (
              <div
                key={`recent-${item.id}`}
                onClick={() => navigateTo("details", item.id)}
                className="group cursor-pointer rounded-2xl overflow-hidden bg-[var(--bg-card)]/95 border border-[var(--border-subtle)] hover:border-[var(--primary)] transition-colors p-2 space-y-2 active:scale-95"
              >
                <div className="relative aspect-[3/4] rounded-xl overflow-hidden bg-neutral-900">
                  <img
                    src={item.posterImage}
                    alt={item.title}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute top-1.5 right-1.5 yg-dark-surface px-1.5 py-0.5 rounded bg-black/75 text-[9px] font-bold text-white">
                    {item.rating}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-bold text-white truncate group-hover:text-[var(--primary)] transition-colors">
                    {item.title}
                  </p>
                  <p className="text-[10px] text-[var(--text-muted)] truncate">
                    {item.status} · {(item.genres || [])[0] || "Anime"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Catalog Row with Genre Filter */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg sm:text-xl font-bold text-white">Popular on YG Flash</h2>
            <p className="text-xs text-[var(--text-muted)]">Handcrafted, high-fidelity anime streams</p>
          </div>
          <button
            type="button"
            onClick={() => navigateTo("search")}
            className="text-xs text-[var(--primary)] font-medium hover:underline"
          >
            View all
          </button>
        </div>

        {availableGenres.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
            {availableGenres.map((genre) => {
              const active = selectedGenre === genre;
              return (
                <button
                  key={genre}
                  type="button"
                  onClick={() => setSelectedGenre(genre)}
                  className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    active
                      ? "bg-[var(--primary)] text-white shadow-sm"
                      : "bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-white"
                  }`}
                >
                  {genre}
                </button>
              );
            })}
          </div>
        )}

        {isLoadingCatalog ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="aspect-[3/4] rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] animate-pulse"
              />
            ))}
          </div>
        ) : filteredCatalog.length === 0 ? (
          <div className="p-8 rounded-3xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-center space-y-3">
            <p className="text-sm text-neutral-400">
              {catalog.length === 0
                ? "The public catalog is currently empty."
                : `No anime found under "${selectedGenre}".`}
            </p>
            {catalog.length === 0 && isAdmin ? (
              <button
                type="button"
                onClick={() => navigateTo("admin")}
                className="theme-btn-primary px-5 py-2 rounded-xl text-xs font-bold"
              >
                Go to Admin Dashboard to Add Anime
              </button>
            ) : catalog.length > 0 ? (
              <button
                type="button"
                onClick={() => setSelectedGenre("All")}
                className="px-4 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs font-bold text-white"
              >
                Show All Genres
              </button>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">
                Admin is currently preparing upcoming anime releases.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredCatalog.map((anime) => {
              const savedWatch = activeResumeByAnime.get(anime.id);
              const pct =
                savedWatch && savedWatch.durationSeconds > 0
                  ? Math.min(100, Math.round((savedWatch.progressSeconds / savedWatch.durationSeconds) * 100))
                  : 0;
              return (
                <div
                  key={anime.id}
                  onClick={() => navigateTo("details", anime.id)}
                  className="group cursor-pointer rounded-2xl overflow-hidden bg-[var(--bg-card)]/95 border border-[var(--border-subtle)] hover:border-[var(--primary)] shadow-xl shadow-black/50 transition-colors flex flex-col active:scale-[0.98]"
                >
                  {/* Poster */}
                  <div className="relative aspect-[3/4] w-full overflow-hidden bg-neutral-900">
                    <img
                      src={anime.posterImage}
                      alt={anime.title}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                      referrerPolicy="no-referrer"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-75 group-hover:opacity-50 transition-opacity" />

                    <div className="absolute top-2.5 right-2.5 yg-dark-surface px-2 py-0.5 rounded-md bg-black/80 text-[10px] font-bold text-white border border-white/10">
                      {anime.rating}
                    </div>

                    {savedWatch && (
                      <div className="yg-dark-surface absolute bottom-2 left-2 right-2 z-10 space-y-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            resumeAnimePlayback(anime, savedWatch);
                          }}
                          title={`Resume Episode ${savedWatch.episodeNumber}`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--primary)]/95 hover:bg-[var(--primary)] text-[10px] font-bold text-white shadow transition-colors"
                        >
                          <Play className="w-2.5 h-2.5 fill-current" />
                          <span>
                            Resume Ep {savedWatch.episodeNumber} · {formatResumeTime(savedWatch.progressSeconds)}
                          </span>
                        </button>
                        <div className="h-1 w-full bg-white/20 rounded-full overflow-hidden">
                          <div className="h-full bg-[var(--primary)]" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )}

                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="w-12 h-12 rounded-full bg-[var(--primary)] text-white flex items-center justify-center shadow-lg">
                        <Play className="w-5 h-5 fill-current translate-x-0.5" />
                      </div>
                    </div>
                  </div>

                  {/* Details */}
                  <div className="p-3 flex-1 flex flex-col justify-between">
                    <div>
                      <h3 className="text-xs md:text-sm font-bold text-white line-clamp-1 group-hover:text-[var(--primary)] transition-colors">
                        {anime.title}
                      </h3>
                      {anime.titleJapanese && (
                        <p className="text-[11px] text-[var(--text-muted)] line-clamp-1 mt-0.5">
                          {anime.titleJapanese}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] font-medium text-[var(--text-muted)] mt-2">
                      <span>{anime.year}</span>
                      <span aria-hidden="true">·</span>
                      <span>{anime.episodesCount} Ep</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{anime.genres?.[0] || "Anime"}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
