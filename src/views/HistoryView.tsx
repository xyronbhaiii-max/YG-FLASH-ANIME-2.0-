import React, { useMemo } from "react";
import { ArrowLeft, Trash2, Play, Clock } from "lucide-react";
import { useApp } from "../context/AppContext";
import { dedupeWatchHistoryByAnime } from "../utils/historyDedupe";

export const HistoryView: React.FC = () => {
  const { history, clearHistory, navigateTo, goBack, catalog, resumeAnimePlayback } = useApp();

  const catalogById = useMemo(() => new Map(catalog.map((a) => [a.id, a])), [catalog]);

  const validHistory = useMemo(
    () => dedupeWatchHistoryByAnime(history, 30).filter((item) => catalogById.has(item.animeId)),
    [history, catalogById]
  );

  const handleResume = (item: (typeof validHistory)[number]) => {
    const anime = catalogById.get(item.animeId);
    if (!anime) {
      return;
    }
    resumeAnimePlayback(anime, item);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-4 md:py-8 space-y-6 pb-24">
      {/* Top Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={goBack}
            aria-label="Back to home"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-white active:scale-95 transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-extrabold text-white">Watch History</h1>
            <p className="text-xs text-[var(--text-muted)]">
              {validHistory.length} watched video{validHistory.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        {validHistory.length > 0 && (
          <button
            type="button"
            onClick={clearHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 text-xs font-semibold transition-all"
          >
            <Trash2 className="w-4 h-4" />
            <span>Clear All</span>
          </button>
        )}
      </div>

      {/* History List */}
      {validHistory.length === 0 ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center p-8 text-center rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <Clock className="w-12 h-12 text-[var(--text-muted)] mb-3 opacity-60" />
          <h3 className="text-base font-bold text-white mb-1">No watch history yet</h3>
          <p className="text-xs text-[var(--text-muted)] max-w-sm mb-4">
            Episodes you stream will appear here so you can easily resume where you left off.
          </p>
          <button
            type="button"
            onClick={() => navigateTo("home")}
            className="theme-btn-primary px-5 py-2 rounded-xl text-xs font-bold"
          >
            Browse Anime
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {validHistory.map((item) => {
            const percent =
              item.durationSeconds > 0
                ? Math.min(100, Math.round((item.progressSeconds / item.durationSeconds) * 100))
                : 0;

            return (
              <div
                key={`${item.animeId}-${item.episodeId}`}
                className="p-3.5 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition-all"
              >
                <div className="flex items-center gap-3.5 flex-1 min-w-0">
                  <div className="w-16 h-20 rounded-xl overflow-hidden bg-neutral-900 shrink-0 border border-white/5 relative">
                    <img
                      src={item.poster}
                      alt={item.animeTitle}
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                    <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                      <Play className="w-5 h-5 text-white/90 fill-current" />
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-white truncate">
                      {item.animeTitle}
                    </h3>
                    <p className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                      Episode {item.episodeNumber}: {item.episodeTitle}
                    </p>

                    {/* Progress Bar */}
                    <div className="mt-2.5 w-full max-w-xs space-y-1">
                      <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--primary)] rounded-full"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-[var(--text-muted)]">
                        {percent}% completed
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-center">
                  <button
                    type="button"
                    onClick={() => handleResume(item)}
                    className="theme-btn-primary px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 active:scale-95 transition-transform"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Resume</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateTo("details", item.animeId)}
                    className="px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:border-white/20 text-xs font-medium text-white transition-colors"
                  >
                    Details
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
