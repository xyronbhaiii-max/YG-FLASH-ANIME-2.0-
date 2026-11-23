import React, { useState, useMemo } from "react";
import { Search, ArrowLeft, X, Film, Play } from "lucide-react";
import { useApp } from "../context/AppContext";
import { sound } from "../utils/sound";
import { dedupeWatchHistoryByAnime, isActiveContinueWatchingItem } from "../utils/historyDedupe";

const GENRES = [
  "All",
  "Action",
  "Adventure",
  "Cyberpunk",
  "Fantasy",
  "Sci-Fi",
  "Supernatural",
  "Mystery",
  "Drama",
  "Comedy",
  "Romance",
];

function formatResumeTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export const SearchView: React.FC = () => {
  const { catalog, navigateTo, resumeAnimePlayback, history, goBack } = useApp();
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedGenre, setSelectedGenre] = useState<string>("All");

  const activeResumeByAnime = useMemo(() => {
    const map = new Map<string, (typeof history)[number]>();
    for (const item of dedupeWatchHistoryByAnime(history, 50)) {
      if (isActiveContinueWatchingItem(item)) {
        map.set(item.animeId, item);
      }
    }
    return map;
  }, [history]);

  const filteredAnime = useMemo(() => {
    return catalog.filter((anime) => {
      const animeGenres = Array.isArray(anime.genres) ? anime.genres : [];
      const matchesGenre = selectedGenre === "All" || animeGenres.includes(selectedGenre);
      const q = searchQuery.trim().toLowerCase();
      const matchesQuery =
        !q ||
        anime.title.toLowerCase().includes(q) ||
        (anime.titleJapanese && anime.titleJapanese.toLowerCase().includes(q)) ||
        (anime.synopsis || "").toLowerCase().includes(q) ||
        animeGenres.some((g) => g.toLowerCase().includes(q));

      return matchesGenre && matchesQuery;
    });
  }, [catalog, searchQuery, selectedGenre]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-4 md:py-8 space-y-6 pb-24">
      {/* Top Header with Back Arrow */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back to home"
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-white active:scale-95 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {/* Search Input Bar */}
        <div className="flex-1 relative flex items-center">
          <Search className="absolute left-4 w-5 h-5 text-[var(--text-muted)] pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search anime title, Japanese name, or genre..."
            className="w-full h-12 pl-12 pr-10 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] focus:border-[var(--primary)] text-white text-sm placeholder:text-[var(--text-muted)] focus:outline-none transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                sound.playClick();
              }}
              className="absolute right-3.5 p-1 rounded-full text-[var(--text-muted)] hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Genre Filter Segmented Bar */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
        {GENRES.map((genre) => (
          <button
            key={genre}
            type="button"
            onClick={() => {
              setSelectedGenre(genre);
              sound.playClick();
            }}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors ${
              selectedGenre === genre
                ? "bg-[var(--primary)] text-white shadow-sm"
                : "bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-white border border-[var(--border-subtle)]"
            }`}
          >
            {genre}
          </button>
        ))}
      </div>

      {/* Results Header */}
      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>Found {filteredAnime.length} title{filteredAnime.length === 1 ? "" : "s"}</span>
        {selectedGenre !== "All" && <span>Filtered by: {selectedGenre}</span>}
      </div>

      {/* Anime Grid */}
      {filteredAnime.length === 0 ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center p-8 text-center rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <Film className="w-12 h-12 text-[var(--text-muted)] mb-3 opacity-60" />
          <h3 className="text-base font-bold text-white mb-1">No anime found</h3>
          <p className="text-xs text-[var(--text-muted)] max-w-sm">
            Try adjusting your search terms or selecting another genre category.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {filteredAnime.map((anime) => {
            const savedWatch = activeResumeByAnime.get(anime.id);
            return (
              <div
                key={anime.id}
                onClick={() => navigateTo("details", anime.id)}
                className="group cursor-pointer rounded-2xl overflow-hidden bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] transition-colors flex flex-col active:scale-[0.98]"
              >
                {/* Poster Image */}
                <div className="relative aspect-[3/4] w-full overflow-hidden bg-neutral-900">
                  <img
                    src={anime.posterImage}
                    alt={anime.title}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-80 group-hover:opacity-60 transition-opacity" />

                  {/* Rating Badge */}
                  <div className="yg-dark-surface absolute top-2.5 right-2.5 px-2 py-0.5 rounded-md bg-black/80 text-[10px] font-bold text-white border border-white/10">
                    {anime.rating}
                  </div>

                  {savedWatch && (
                    <div className="yg-dark-surface absolute bottom-2 left-2 right-2 z-10">
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
                    </div>
                  )}

                  {/* Play hover trigger */}
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="w-12 h-12 rounded-full bg-[var(--primary)] text-white flex items-center justify-center shadow-lg">
                      <Play className="w-5 h-5 fill-current translate-x-0.5" />
                    </div>
                  </div>
                </div>

                {/* Title & Quiet Metadata */}
                <div className="p-3 flex-1 flex flex-col justify-between">
                  <div>
                    <h4 className="text-xs md:text-sm font-bold text-white line-clamp-1 group-hover:text-[var(--primary)] transition-colors">
                      {anime.title}
                    </h4>
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
  );
};
