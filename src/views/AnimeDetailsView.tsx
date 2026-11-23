import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ArrowLeft,
  Play,
  Bookmark,
  Share2,
  Tv,
  Layers,
  Check,
  Languages,
  ListVideo,
  ListPlus,
  ListCheck,
} from "lucide-react";
import { useApp, Anime, Episode, EPISODE_LANGUAGES } from "../context/AppContext";
import { getValidAdminIdToken } from "../lib/firebase";
import { subscribeToAnimeEpisodes, fetchAnimeEpisodesOnce, sortEpisodes, mergeEpisodeLists } from "../lib/firebaseCatalog";
import { formatAgeRatingLabel, isRestrictedMatureRating } from "../utils/ageRating";
import { normalizeQualityCode, sortSourcesByQuality } from "../utils/videoQuality";
import { getStreamMimeType, isHlsStreamUrl } from "../utils/streamUrl";
import { apiUrl, resolveMediaUrl } from "../utils/apiUrl";
import { sound } from "../utils/sound";

function formatShortTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export const AnimeDetailsView: React.FC = () => {
  const {
    selectedAnimeId,
    goBack,
    catalog,
    startPlayback,
    favorites,
    toggleFavorite,
    watchlist,
    toggleWatchlist,
    history,
    isAdmin,
  } = useApp();

  const [anime, setAnime] = useState<Anime | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [hasLoadedEpisodes, setHasLoadedEpisodes] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [selectedSource, setSelectedSource] = useState<string>("Primary CDN");
  const [selectedSeasonFilter, setSelectedSeasonFilter] = useState<number | "ALL">("ALL");
  const [selectedLanguageFilter, setSelectedLanguageFilter] = useState<string>("ALL");
  const [selectedJumpEpisodeId, setSelectedJumpEpisodeId] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const activeAnimeIdRef = useRef<string | null>(selectedAnimeId);
  activeAnimeIdRef.current = selectedAnimeId;
  const serverEpsRef = useRef<Episode[]>([]);
  const fbEpsRef = useRef<Episode[]>([]);

  const syncMergedEpisodes = useCallback(() => {
    setEpisodes(mergeEpisodeLists(serverEpsRef.current, fbEpsRef.current));
  }, []);

  const fetchDetails = useCallback(async (showSpinner = true) => {
    const targetAnimeId = selectedAnimeId;
    if (!targetAnimeId) return;
    if (showSpinner) setIsLoading(true);
    try {
      const headers: Record<string, string> = {};
      if (isAdmin) {
        const bearerToken = await getValidAdminIdToken(false).catch(() => "");
        if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
      }

      const [res, fbOnce] = await Promise.all([
        fetch(apiUrl(`/api/anime/${targetAnimeId}`), {
          headers,
          credentials: "include",
        }).catch(() => null),
        fetchAnimeEpisodesOnce(targetAnimeId, isAdmin).catch(() => [] as Episode[]),
      ]);
      if (activeAnimeIdRef.current !== targetAnimeId) return;

      if (fbOnce.length > 0 && fbEpsRef.current.length === 0) {
        fbEpsRef.current = fbOnce;
      }

      if (res && res.ok) {
        const data = await res.json();
        if (activeAnimeIdRef.current !== targetAnimeId) return;
        setAnime(data.anime);
        serverEpsRef.current = Array.isArray(data.episodes) ? data.episodes : [];
        if (data.anime?.streamingSources?.[0]?.name) {
          setSelectedSource(data.anime.streamingSources[0].name);
        }
      }
      syncMergedEpisodes();
    } catch (err) {
      console.error("Failed to load anime details:", err);
    } finally {
      if (activeAnimeIdRef.current === targetAnimeId) {
        setHasLoadedEpisodes(true);
        if (showSpinner) setIsLoading(false);
      }
    }
  }, [selectedAnimeId, isAdmin, syncMergedEpisodes]);

  useEffect(() => {
    if (!selectedAnimeId) return;
    const cached = catalog.find((a) => a.id === selectedAnimeId);
    if (cached) {
      setAnime((prev) => (prev && prev.id === cached.id && prev.updatedAt === cached.updatedAt ? prev : cached));
    }
  }, [selectedAnimeId, catalog]);

  useEffect(() => {
    setSelectedSeasonFilter("ALL");
    setSelectedLanguageFilter("ALL");
    setSelectedJumpEpisodeId("");
  }, [selectedAnimeId]);

  useEffect(() => {
    if (!selectedAnimeId) return;

    serverEpsRef.current = [];
    fbEpsRef.current = [];
    setEpisodes([]);
    setHasLoadedEpisodes(false);
    fetchDetails(true);

    const onCatalogUpdated = () => {
      fetchDetails(false);
    };
    window.addEventListener("yg:catalog-updated", onCatalogUpdated);

    const unsubEpisodes = subscribeToAnimeEpisodes(
      selectedAnimeId,
      isAdmin,
      (fbEpisodes, meta) => {
        if (activeAnimeIdRef.current !== selectedAnimeId) return;
        if (meta?.hasSnapshot) {
          fbEpsRef.current = fbEpisodes;
          syncMergedEpisodes();
          setHasLoadedEpisodes(true);
        }
      }
    );

    return () => {
      window.removeEventListener("yg:catalog-updated", onCatalogUpdated);
      unsubEpisodes();
    };
  }, [selectedAnimeId, isAdmin, fetchDetails, syncMergedEpisodes]);

  const mappedAnimeSources = useMemo(
    () =>
      (anime?.streamingSources || [])
        .filter((s) => Boolean(s.url))
        .map((s) => ({
          label: s.name,
          url: s.url,
          quality: s.quality || "1080p",
          type: getStreamMimeType(s.url),
        })),
    [anime?.streamingSources]
  );

  const chosenStreamSource =
    anime?.streamingSources?.find((s) => s.name === selectedSource) ||
    anime?.streamingSources?.[0];

  const displayEpisodes: Episode[] = useMemo(() => {
    if (!anime) return [];
    if (episodes.length > 0) {
      return sortEpisodes(episodes).map((ep) => {
        const ownSources = Array.isArray(ep.sources)
          ? ep.sources.filter((s) => Boolean(s?.url?.trim()))
          : [];
        const hasOwnStream = ownSources.length > 0 || Boolean(ep.videoUrl?.trim());
        const resolvedSources =
          ownSources.length > 0
            ? sortSourcesByQuality(
                ownSources.map((s) => ({
                  ...s,
                  quality: normalizeQualityCode(s.quality || s.label),
                }))
              )
            : hasOwnStream
            ? [
                {
                  label: isHlsStreamUrl(ep.videoUrl!.trim()) ? "HLS Adaptive" : "1080p Full HD",
                  url: ep.videoUrl!.trim(),
                  quality: "1080p",
                  type: getStreamMimeType(ep.videoUrl!.trim()),
                },
              ]
            : [];

        return {
          ...ep,
          season: ep.season || 1,
          language: ep.language || "Japanese",
          description: ep.description ?? ep.synopsis ?? "",
          sources: resolvedSources,
        };
      });
    }
    if (!hasLoadedEpisodes) return [];
    // Only synthesize a single movie/primary fallback when no real episode documents exist and anime itself carries a stream URL
    if (mappedAnimeSources.length > 0 && chosenStreamSource?.url?.trim()) {
      return [
        {
          id: `ep-${anime.id}-1`,
          animeId: anime.id,
          number: 1,
          season: 1,
          title: anime.title,
          language: "Japanese",
          description: anime.synopsis || `Stream ${anime.title}`,
          synopsis: anime.synopsis || `Stream ${anime.title}`,
          duration: "24m",
          videoUrl: chosenStreamSource.url.trim(),
          sources: mappedAnimeSources,
          createdAt: anime.createdAt || new Date().toISOString(),
        },
      ];
    }
    return [];
  }, [anime, episodes, hasLoadedEpisodes, mappedAnimeSources, chosenStreamSource?.url]);

  const availableSeasons = useMemo(() => {
    const set = new Set<number>();
    for (const ep of displayEpisodes) {
      set.add(ep.season || 1);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [displayEpisodes]);

  const availableLanguages = useMemo(() => {
    const present = new Set<string>();
    for (const ep of displayEpisodes) {
      if (ep.language?.trim()) present.add(ep.language.trim());
    }
    const orderedPresets = EPISODE_LANGUAGES.filter((l) => present.has(l));
    const customLangs = Array.from(present)
      .filter((l) => !(EPISODE_LANGUAGES as readonly string[]).includes(l))
      .sort((a, b) => a.localeCompare(b));
    const combined = [...orderedPresets, ...customLangs];
    return combined.length > 0 ? combined : ["Japanese"];
  }, [displayEpisodes]);

  const filteredEpisodes = useMemo(() => {
    return displayEpisodes.filter((ep) => {
      const seasonOk = selectedSeasonFilter === "ALL" || (ep.season || 1) === selectedSeasonFilter;
      const langOk =
        selectedLanguageFilter === "ALL" || (ep.language || "Japanese") === selectedLanguageFilter;
      return seasonOk && langOk;
    });
  }, [displayEpisodes, selectedSeasonFilter, selectedLanguageFilter]);

  const episodesGroupedBySeason = useMemo(() => {
    const groups = new Map<number, Episode[]>();
    for (const ep of filteredEpisodes) {
      const s = ep.season || 1;
      const list = groups.get(s) || [];
      list.push(ep);
      groups.set(s, list);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
  }, [filteredEpisodes]);

  if (!selectedAnimeId || (!anime && !isLoading)) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center">
        <p className="text-neutral-400 mb-4">Anime not found or unpublished.</p>
        <button
          type="button"
          onClick={goBack}
          className="px-4 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-white"
        >
          Back to Catalog
        </button>
      </div>
    );
  }

  if (isLoading && !anime) {
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-6 animate-pulse">
        <div className="h-64 rounded-3xl bg-[var(--bg-card)] border border-[var(--border-subtle)]" />
        <div className="h-8 w-1/2 bg-[var(--bg-card)] rounded-lg" />
        <div className="h-24 bg-[var(--bg-card)] rounded-lg" />
      </div>
    );
  }

  if (!anime) return null;

  const isFavorited = favorites.includes(anime.id);
  const isInWatchlist = watchlist.includes(anime.id);
  const animeHistory = history
    .filter((h) => h.animeId === anime.id)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const lastWatched = animeHistory.length > 0 ? animeHistory[0] : null;

  const handleShare = () => {
    sound.playClick();
    if (navigator.share) {
      navigator
        .share({
          title: anime.title,
          text: `Watch ${anime.title} on YG Flash Anime!`,
          url: window.location.href,
        })
        .catch(() => {});
    } else if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(window.location.href)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {});
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-4 md:py-8 space-y-8 pb-24">
      {/* Top Back Navigation Bar */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back to previous page"
          className="min-h-[44px] min-w-[44px] inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-white text-sm font-medium transition-all active:scale-95"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleShare}
            aria-label="Share Anime"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-white transition-colors"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Share2 className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={() => toggleWatchlist(anime.id)}
            aria-label={isInWatchlist ? "Remove from Watchlist" : "Add to Watchlist"}
            className={`min-h-[44px] px-3.5 flex items-center gap-1.5 rounded-xl bg-[var(--bg-card)] border text-xs font-bold transition-all ${
              isInWatchlist
                ? "border-[var(--primary)] text-[var(--primary)]"
                : "border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-white"
            }`}
          >
            {isInWatchlist ? <ListCheck className="w-4 h-4" /> : <ListPlus className="w-4 h-4" />}
            <span>{isInWatchlist ? "In Watchlist" : "Watchlist"}</span>
          </button>
          <button
            type="button"
            onClick={() => toggleFavorite(anime.id)}
            aria-label="Save to favorites"
            className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[var(--bg-card)] border transition-all ${
              isFavorited
                ? "border-[var(--primary)] text-[var(--primary)]"
                : "border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-white"
            }`}
          >
            <Bookmark className={`w-4 h-4 ${isFavorited ? "fill-current" : ""}`} />
          </button>
        </div>
      </div>

      {/* Hero Banner with Poster & Info */}
      <div className="relative rounded-3xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        {/* Banner Backdrop */}
        <div className="relative h-64 md:h-96 w-full overflow-hidden">
          <img
            src={resolveMediaUrl(anime.bannerImage || anime.posterImage)}
            alt={anime.title}
            className="w-full h-full object-cover filter brightness-60"
            referrerPolicy="no-referrer"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-surface)] via-[var(--bg-surface)]/60 to-transparent" />
        </div>

        {/* Content Overlay */}
        <div className="relative -mt-32 md:-mt-48 p-6 md:p-8 flex flex-col md:flex-row gap-6 md:gap-8 items-start">
          {/* Poster Card */}
          <div className="w-36 sm:w-48 md:w-56 shrink-0 aspect-[3/4] rounded-2xl overflow-hidden border-2 border-[var(--border-subtle)] shadow-2xl bg-black/40 mx-auto md:mx-0">
            <img
              src={resolveMediaUrl(anime.posterImage)}
              alt={anime.title}
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          </div>

          {/* Metadata Section */}
          <div className="flex-1 space-y-4">
            <div>
              {anime.titleJapanese && (
                <p className="text-xs md:text-sm font-semibold tracking-wider text-[var(--primary)] uppercase mb-1">
                  {anime.titleJapanese}
                </p>
              )}
              <h1 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-white tracking-tight text-balance">
                {anime.title}
              </h1>
            </div>

            {/* Quiet Unboxed Metadata with Bullet Separators */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)] font-medium">
              <span className="text-white font-semibold">{formatAgeRatingLabel(anime.rating)}</span>
              {isRestrictedMatureRating(anime.rating) && (
                <span className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/35 text-rose-300 text-[10px] font-bold">
                  Mature Rated
                </span>
              )}
              <span aria-hidden="true">·</span>
              <span>{anime.year}</span>
              <span aria-hidden="true">·</span>
              <span>{anime.status}</span>
              <span aria-hidden="true">·</span>
              <span>
                {Math.max(anime.seasons || 1, availableSeasons.length)} Season
                {Math.max(anime.seasons || 1, availableSeasons.length) === 1 ? "" : "s"}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {anime.episodesCount ?? displayEpisodes.length} Episode
                {(anime.episodesCount ?? displayEpisodes.length) === 1 ? "" : "s"}
              </span>
            </div>

            {/* Genres */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(Array.isArray(anime.genres) ? anime.genres : []).map((g) => (
                <span
                  key={g}
                  className="px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--badge-bg)] text-[var(--badge-text)]"
                >
                  {g}
                </span>
              ))}
            </div>

            {/* Synopsis */}
            <p className="text-sm md:text-base text-neutral-300 leading-relaxed max-w-2xl">
              {anime.synopsis}
            </p>

            {/* CTA Play Button */}
            <div className="pt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={displayEpisodes.length === 0}
                onClick={() => {
                  const targetEp = lastWatched
                    ? displayEpisodes.find((e) => e.id === lastWatched.episodeId) ||
                      displayEpisodes.find(
                        (e) =>
                          e.number === lastWatched.episodeNumber &&
                          (e.season || 1) === (lastWatched.season || 1)
                      ) ||
                      displayEpisodes[0]
                    : displayEpisodes[0];
                  if (targetEp) startPlayback(anime, targetEp);
                }}
                className="theme-btn-primary min-h-[48px] px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2.5 shadow-lg active:scale-95 transition-transform disabled:opacity-50"
              >
                <Play className="w-5 h-5 fill-current" />
                <span>
                  {displayEpisodes.length === 0
                    ? "Episodes Coming Soon"
                    : lastWatched
                    ? `Resume Ep ${lastWatched.episodeNumber} · ${formatShortTime(lastWatched.progressSeconds)}`
                    : `Watch Episode ${displayEpisodes[0]?.number || 1}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Streaming Sources Selector */}
      {anime.streamingSources && anime.streamingSources.length > 0 && (
        <div className="p-4 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-muted)]">
            <Tv className="w-4 h-4 text-[var(--primary)]" />
            <span>Authorized Streaming CDN:</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {anime.streamingSources.map((src) => (
              <button
                key={src.name}
                type="button"
                onClick={() => {
                  setSelectedSource(src.name);
                  sound.playClick();
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  selectedSource === src.name
                    ? "bg-[var(--primary)] text-white shadow-sm"
                    : "bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-white"
                }`}
              >
                {src.name}{src.quality ? ` · ${src.quality}` : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Episodes Section with Season Grouping, Language Selection & Quick Episode Selector */}
      <div className="space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Layers className="w-5 h-5 text-[var(--primary)]" />
            <span>Episodes ({filteredEpisodes.length})</span>
          </h2>

          {/* Functional Episode Selector Dropdown */}
          <div className="flex items-center gap-2">
            <div className="relative flex items-center flex-1 sm:flex-initial">
              <ListVideo className="w-4 h-4 text-[var(--primary)] absolute left-3 pointer-events-none" />
              <select
                aria-label="Episode Selector"
                value={selectedJumpEpisodeId}
                onChange={(e) => {
                  const chosenId = e.target.value;
                  const found = displayEpisodes.find((ep) => ep.id === chosenId);
                  setSelectedJumpEpisodeId("");
                  if (found) {
                    startPlayback(anime, found);
                  }
                }}
                className="min-h-[40px] w-full sm:w-72 pl-9 pr-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] focus:border-[var(--primary)] text-xs font-semibold text-white focus:outline-none"
              >
                <option value="">Jump to Episode ({displayEpisodes.length})...</option>
                {displayEpisodes.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    S{ep.season || 1} · E{ep.number} — {ep.title} ({ep.language || "Japanese"})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Season Tabs + Language Selection Bar */}
        <div className="p-3.5 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {/* Season Filter */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-semibold text-[var(--text-muted)] mr-1">Season:</span>
            <button
              type="button"
              onClick={() => {
                setSelectedSeasonFilter("ALL");
                sound.playClick();
              }}
              className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                selectedSeasonFilter === "ALL"
                  ? "bg-[var(--primary)] text-white shadow-sm"
                  : "bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-white"
              }`}
            >
              All
            </button>
            {availableSeasons.map((sNum) => (
              <button
                key={sNum}
                type="button"
                onClick={() => {
                  setSelectedSeasonFilter(sNum);
                  sound.playClick();
                }}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                  selectedSeasonFilter === sNum
                    ? "bg-[var(--primary)] text-white shadow-sm"
                    : "bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-white"
                }`}
              >
                Season {sNum}
              </button>
            ))}
          </div>

          {/* Language Filter */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--text-muted)] mr-1">
              <Languages className="w-3.5 h-3.5 text-[var(--primary)]" />
              <span>Language:</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setSelectedLanguageFilter("ALL");
                sound.playClick();
              }}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                selectedLanguageFilter === "ALL"
                  ? "bg-white/15 text-white border border-white/25"
                  : "bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-white"
              }`}
            >
              All
            </button>
            {availableLanguages.map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => {
                  setSelectedLanguageFilter(lang);
                  sound.playClick();
                }}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                  selectedLanguageFilter === lang
                    ? "bg-[var(--primary)] text-white shadow-sm"
                    : "bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-white"
                }`}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>

        {/* Grouped Season Episode Lists (merges multi-language versions of the same episode cleanly) */}
        {episodesGroupedBySeason.length === 0 ? (
          <div className="p-6 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-center text-xs text-[var(--text-muted)]">
            {displayEpisodes.length === 0
              ? "No episodes uploaded yet for this anime."
              : "No episodes match the selected Season and Language filter."}
          </div>
        ) : (
          <div className="space-y-6">
            {episodesGroupedBySeason.map(([seasonNum, seasonEps]) => {
              // Group same-number episodes so multi-language tracks display under one episode card
              const byNumberMap = new Map<number, Episode[]>();
              for (const ep of seasonEps) {
                const list = byNumberMap.get(ep.number) || [];
                list.push(ep);
                byNumberMap.set(ep.number, list);
              }
              const groupedNumberEntries = Array.from(byNumberMap.entries()).sort(
                (a, b) => a[0] - b[0]
              );

              return (
                <div key={seasonNum} className="space-y-3">
                  <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-2">
                    <h3 className="text-sm font-bold text-white">Season {seasonNum}</h3>
                    <span className="text-[11px] text-[var(--text-muted)] font-medium">
                      {groupedNumberEntries.length} Episode
                      {groupedNumberEntries.length === 1 ? "" : "s"}
                      {seasonEps.length > groupedNumberEntries.length
                        ? ` · ${seasonEps.length} Language Tracks`
                        : ""}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {groupedNumberEntries.map(([epNum, versions]) => {
                      const primaryEp = versions[0];
                      const epWatch = animeHistory.find(
                        (h) =>
                          versions.some((v) => v.id === h.episodeId) ||
                          (h.episodeNumber === epNum && (h.season || 1) === seasonNum)
                      );
                      const pct =
                        epWatch && epWatch.durationSeconds > 0
                          ? Math.min(
                              100,
                              Math.round((epWatch.progressSeconds / epWatch.durationSeconds) * 100)
                            )
                          : 0;
                      const descText = primaryEp.description || primaryEp.synopsis || "";
                      const resumeVersion =
                        (epWatch && versions.find((v) => v.id === epWatch.episodeId)) ||
                        primaryEp;

                      return (
                        <div
                          key={`${seasonNum}-${epNum}`}
                          onClick={() => startPlayback(anime, resumeVersion)}
                          className="group p-3.5 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] cursor-pointer transition-all active:scale-[0.98] flex flex-col gap-2.5"
                        >
                          <div className="flex items-center gap-3">
                            {primaryEp.thumbnailUrl ? (
                              <div className="relative w-16 h-12 rounded-xl overflow-hidden bg-black/60 border border-[var(--border-subtle)] group-hover:border-[var(--primary)] shrink-0">
                                <img
                                  src={resolveMediaUrl(primaryEp.thumbnailUrl)}
                                  alt={primaryEp.title}
                                  className="w-full h-full object-cover"
                                  referrerPolicy="no-referrer"
                                />
                                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                                  <Play className="w-4 h-4 text-white fill-current" />
                                </div>
                              </div>
                            ) : (
                              <div className="w-12 h-12 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] group-hover:border-[var(--primary)] flex items-center justify-center text-[var(--primary)] font-bold text-sm shrink-0">
                                <Play className="w-5 h-5 fill-current" />
                              </div>
                            )}

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-bold text-white truncate">
                                  S{seasonNum} · Episode {epNum}
                                </span>
                                <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0">
                                  {primaryEp.duration || "24m"}
                                </span>
                              </div>
                              <p className="text-xs text-neutral-300 truncate mt-0.5 font-medium">
                                {primaryEp.title}
                              </p>
                              <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
                                {versions.map((ver) => {
                                  const sortedVers = sortSourcesByQuality(
                                    (ver.sources || []).filter((s) => Boolean(s?.url?.trim()))
                                  );
                                  const topSource = sortedVers[0];
                                  const topIsHls =
                                    topSource?.type === "application/x-mpegURL" ||
                                    isHlsStreamUrl(topSource?.url || ver.videoUrl);
                                  const topQ = topIsHls ? "HLS" : topSource?.quality;
                                  return (
                                    <button
                                      key={ver.id}
                                      type="button"
                                      title={ver.title}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        startPlayback(anime, ver);
                                      }}
                                      className="px-1.5 py-0.5 rounded bg-[var(--badge-bg)] hover:bg-[var(--primary)] text-[var(--badge-text)] hover:text-white text-[10px] font-semibold transition-colors"
                                    >
                                      {ver.language || "Japanese"}
                                      {topQ ? ` · ${topQ === "HLS" ? "HLS" : normalizeQualityCode(topQ)}` : ""}
                                    </button>
                                  );
                                })}
                                {epWatch && epWatch.progressSeconds >= 0.5 && (
                                  <span className="text-[10px] text-[var(--primary)] font-semibold">
                                    Resume {formatShortTime(epWatch.progressSeconds)}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {descText && (
                            <p className="text-[11px] text-[var(--text-muted)] line-clamp-2 leading-relaxed">
                              {descText}
                            </p>
                          )}

                          {epWatch && epWatch.progressSeconds >= 0.5 && (
                            <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-[var(--primary)]"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
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
