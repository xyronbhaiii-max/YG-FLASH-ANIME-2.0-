import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { RotateCcw } from "lucide-react";

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLElement | string,
        options: {
          width?: string | number;
          height?: string | number;
          videoId: string;
          host?: string;
          playerVars?: Record<string, string | number | undefined>;
          events?: {
            onReady?: (event: { target: YTPlayerInstance }) => void;
            onStateChange?: (event: { data: number; target: YTPlayerInstance }) => void;
            onError?: (event: { data: number; target: YTPlayerInstance }) => void;
            onPlaybackRateChange?: (event: { data: number; target: YTPlayerInstance }) => void;
          };
        }
      ) => YTPlayerInstance;
      PlayerState?: {
        UNSTARTED: number;
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YTPlayerInstance {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  setVolume: (volume: number) => void;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  setPlaybackRate: (suggestedRate: number) => void;
  getPlaybackRate: () => number;
  getAvailablePlaybackRates: () => number[];
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  loadVideoById: (videoId: string, startSeconds?: number) => void;
  destroy: () => void;
}

export interface YouTubePlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  setVolume: (volume01: number) => void;
  setMuted: (muted: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  isPaused: () => boolean;
  reload: () => void;
}

interface YouTubePlayerProps {
  videoId: string;
  volume: number;
  isMuted: boolean;
  playbackRate: number;
  initialSeekSeconds?: number | null;
  allowNativeControls?: boolean;
  onPlayChange: (playing: boolean) => void;
  onBufferingChange: (buffering: boolean) => void;
  onTimeUpdate: (currentTime: number, duration: number) => void;
  onReady?: (duration: number) => void;
  onError: (message: string, code?: number | string) => void;
}

type YtVisualState = "loading" | "playing" | "paused" | "ended";

let ytApiPromise: Promise<NonNullable<Window["YT"]>> | null = null;

function loadYouTubeIframeApi(): Promise<NonNullable<Window["YT"]>> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube player requires a browser environment."));
  }

  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (ytApiPromise) {
    return ytApiPromise;
  }

  ytApiPromise = new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      ytApiPromise = null;
      reject(new Error("Timed out loading YouTube IFrame Player API. Check your internet connection."));
    }, 10000);

    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeoutId);
      if (typeof previousCallback === "function") {
        try {
          previousCallback();
        } catch {}
      }
      if (window.YT?.Player) {
        resolve(window.YT);
      } else {
        ytApiPromise = null;
        reject(new Error("YouTube IFrame API initialized without Player constructor."));
      }
    };

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]'
    );
    if (!existingScript) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timeoutId);
        ytApiPromise = null;
        reject(new Error("Failed to load YouTube IFrame Player API. Verify your network connection."));
      };
      document.head.appendChild(script);
    }
  });

  return ytApiPromise;
}

function mapYouTubeErrorCode(code: number): string {
  switch (code) {
    case 2:
      return "Invalid YouTube video ID or URL parameter. Please verify the YouTube URL.";
    case 5:
      return "This YouTube video cannot be played in the embedded HTML5 player.";
    case 100:
      return "YouTube video unavailable. It may have been removed or marked private.";
    case 101:
    case 150:
      return "Embedding is disabled by the video owner for this YouTube video.";
    default:
      return `YouTube playback error (code ${code}). Video may be unavailable or restricted from embedding.`;
  }
}

export const YouTubePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(
  (
    {
      videoId,
      volume,
      isMuted,
      playbackRate,
      initialSeekSeconds,
      allowNativeControls = false,
      onPlayChange,
      onBufferingChange,
      onTimeUpdate,
      onReady,
      onError,
    },
    ref
  ) => {
    const outerRef = useRef<HTMLDivElement>(null);
    const iframeSlotRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<YTPlayerInstance | null>(null);
    const readyRef = useRef<boolean>(false);
    const pausedRef = useRef<boolean>(true);
    const hasPlayedFrameRef = useRef<boolean>(false);

    const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);
    const [visualState, setVisualState] = useState<YtVisualState>("loading");

    const latestCallbacksRef = useRef({
      onPlayChange,
      onBufferingChange,
      onTimeUpdate,
      onReady,
      onError,
      volume,
      isMuted,
      playbackRate,
      initialSeekSeconds,
    });

    latestCallbacksRef.current = {
      onPlayChange,
      onBufferingChange,
      onTimeUpdate,
      onReady,
      onError,
      volume,
      isMuted,
      playbackRate,
      initialSeekSeconds,
    };

    // Keep exact 16:9 inner stage dimensions so top/bottom overscan hides channel headers & watermarks without cropping video
    useEffect(() => {
      const el = outerRef.current;
      if (!el) return;

      const updateSize = () => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (!w || !h) return;
        const stageW = Math.min(w, (h * 16) / 9);
        const stageH = (stageW * 9) / 16;
        const nextW = Math.round(stageW);
        const nextH = Math.round(stageH);
        setStageSize((prev) =>
          prev && prev.width === nextW && prev.height === nextH
            ? prev
            : { width: nextW, height: nextH }
        );
      };

      updateSize();
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(updateSize);
        observer.observe(el);
        return () => observer.disconnect();
      }
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }, []);

    const initPlayer = React.useCallback(async () => {
      if (!iframeSlotRef.current || !videoId) return;

      readyRef.current = false;
      pausedRef.current = true;
      hasPlayedFrameRef.current = false;
      setVisualState("loading");
      latestCallbacksRef.current.onBufferingChange(true);

      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {}
        playerRef.current = null;
      }

      const slot = iframeSlotRef.current;
      slot.innerHTML = "";
      const mountEl = document.createElement("div");
      mountEl.className = "w-full h-full";
      slot.appendChild(mountEl);

      try {
        const YT = await loadYouTubeIframeApi();
        if (!iframeSlotRef.current || !slot.contains(mountEl)) return;

        const player = new YT.Player(mountEl, {
          width: "100%",
          height: "100%",
          videoId,
          host: "https://www.youtube-nocookie.com",
          playerVars: {
            autoplay: 1,
            playsinline: 1,
            controls: 1,
            rel: 0,
            modestbranding: 1,
            enablejsapi: 1,
            iv_load_policy: 3,
            disablekb: 1,
            fs: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              readyRef.current = true;
              const target = event.target;
              const {
                volume: v,
                isMuted: m,
                playbackRate: rate,
                initialSeekSeconds: seekSec,
                onReady: readyCb,
              } = latestCallbacksRef.current;

              const iframe = slot.querySelector("iframe");
              if (iframe) {
                iframe.className = "w-full h-full border-0 select-none";
                iframe.setAttribute("tabindex", "-1");
                iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
              }

              try {
                target.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100));
                if (m) target.mute();
                else target.unMute();
                const allowedRates = target.getAvailablePlaybackRates?.() || [0.5, 1, 1.5, 2];
                const closestRate = allowedRates.reduce((prev, curr) =>
                  Math.abs(curr - rate) < Math.abs(prev - rate) ? curr : prev
                );
                target.setPlaybackRate(closestRate);
                if (typeof seekSec === "number" && seekSec > 0) {
                  target.seekTo(seekSec, true);
                }
                target.playVideo();
              } catch {}

              // If autoplay is blocked by browser policy, expose play UI instead of staying stuck loading
              window.setTimeout(() => {
                if (!hasPlayedFrameRef.current && readyRef.current) {
                  try {
                    const st = target.getPlayerState?.();
                    if (st !== (window.YT?.PlayerState?.PLAYING ?? 1) && st !== (window.YT?.PlayerState?.BUFFERING ?? 3)) {
                      latestCallbacksRef.current.onBufferingChange(false);
                      latestCallbacksRef.current.onPlayChange(false);
                      setVisualState("paused");
                    }
                  } catch {}
                }
              }, 900);

              const dur = target.getDuration?.() || 0;
              readyCb?.(dur);
            },
            onStateChange: (event) => {
              const state = event.data;
              const target = event.target;
              const States = window.YT?.PlayerState;
              const PLAYING = States?.PLAYING ?? 1;
              const PAUSED = States?.PAUSED ?? 2;
              const BUFFERING = States?.BUFFERING ?? 3;
              const ENDED = States?.ENDED ?? 0;

              if (state === PLAYING) {
                hasPlayedFrameRef.current = true;
                pausedRef.current = false;
                setVisualState("playing");
                latestCallbacksRef.current.onPlayChange(true);
                latestCallbacksRef.current.onBufferingChange(false);
                const curr = target.getCurrentTime?.() || 0;
                const dur = target.getDuration?.() || 0;
                latestCallbacksRef.current.onTimeUpdate(curr, dur);
              } else if (state === PAUSED) {
                pausedRef.current = true;
                setVisualState("paused");
                latestCallbacksRef.current.onPlayChange(false);
                latestCallbacksRef.current.onBufferingChange(false);
                const curr = target.getCurrentTime?.() || 0;
                const dur = target.getDuration?.() || 0;
                if (dur > 0) {
                  latestCallbacksRef.current.onTimeUpdate(curr, dur);
                }
              } else if (state === BUFFERING) {
                latestCallbacksRef.current.onBufferingChange(true);
              } else if (state === ENDED) {
                pausedRef.current = true;
                setVisualState("ended");
                latestCallbacksRef.current.onPlayChange(false);
                latestCallbacksRef.current.onBufferingChange(false);
                const dur = target.getDuration?.() || 0;
                latestCallbacksRef.current.onTimeUpdate(dur, dur);
              } else {
                latestCallbacksRef.current.onBufferingChange(false);
              }
            },
            onError: (event) => {
              readyRef.current = false;
              pausedRef.current = true;
              latestCallbacksRef.current.onBufferingChange(false);
              latestCallbacksRef.current.onPlayChange(false);
              latestCallbacksRef.current.onError(mapYouTubeErrorCode(event.data), event.data);
            },
          },
        });

        playerRef.current = player;
      } catch (err: any) {
        latestCallbacksRef.current.onBufferingChange(false);
        latestCallbacksRef.current.onPlayChange(false);
        latestCallbacksRef.current.onError(
          err?.message || "Unable to load YouTube video player. Verify the URL or your connection.",
          "YT_API_LOAD_FAILED"
        );
      }
    }, [videoId]);

    useEffect(() => {
      initPlayer();
      return () => {
        readyRef.current = false;
        if (playerRef.current) {
          try {
            playerRef.current.destroy();
          } catch {}
          playerRef.current = null;
        }
      };
    }, [initPlayer]);

    useEffect(() => {
      const interval = window.setInterval(() => {
        const player = playerRef.current;
        if (!player || !readyRef.current) return;
        try {
          const state = player.getPlayerState?.();
          if (state === (window.YT?.PlayerState?.PLAYING ?? 1)) {
            const curr = player.getCurrentTime?.() || 0;
            const dur = player.getDuration?.() || 0;
            latestCallbacksRef.current.onTimeUpdate(curr, dur);
          }
        } catch {}
      }, 400);
      return () => window.clearInterval(interval);
    }, []);

    useEffect(() => {
      const player = playerRef.current;
      if (!player || !readyRef.current) return;
      try {
        player.setVolume(Math.round(Math.max(0, Math.min(1, volume)) * 100));
        if (isMuted) player.mute();
        else player.unMute();
      } catch {}
    }, [volume, isMuted]);

    useEffect(() => {
      const player = playerRef.current;
      if (!player || !readyRef.current) return;
      try {
        const allowedRates = player.getAvailablePlaybackRates?.() || [0.5, 1, 1.5, 2];
        const closest = allowedRates.reduce((prev, curr) =>
          Math.abs(curr - playbackRate) < Math.abs(prev - playbackRate) ? curr : prev
        );
        player.setPlaybackRate(closest);
      } catch {}
    }, [playbackRate]);

    useImperativeHandle(ref, () => ({
      play: () => {
        try {
          playerRef.current?.playVideo();
        } catch {}
      },
      pause: () => {
        try {
          playerRef.current?.pauseVideo();
        } catch {}
      },
      seekTo: (seconds: number) => {
        try {
          playerRef.current?.seekTo(Math.max(0, seconds), true);
        } catch {}
      },
      setVolume: (volume01: number) => {
        try {
          playerRef.current?.setVolume(Math.round(Math.max(0, Math.min(1, volume01)) * 100));
        } catch {}
      },
      setMuted: (muted: boolean) => {
        try {
          if (muted) playerRef.current?.mute();
          else playerRef.current?.unMute();
        } catch {}
      },
      setPlaybackRate: (rate: number) => {
        try {
          const allowed = playerRef.current?.getAvailablePlaybackRates?.() || [0.5, 1, 1.5, 2];
          const closest = allowed.reduce((prev, curr) =>
            Math.abs(curr - rate) < Math.abs(prev - rate) ? curr : prev
          );
          playerRef.current?.setPlaybackRate(closest);
        } catch {}
      },
      getCurrentTime: () => {
        try {
          return playerRef.current?.getCurrentTime?.() || 0;
        } catch {
          return 0;
        }
      },
      getDuration: () => {
        try {
          return playerRef.current?.getDuration?.() || 0;
        } catch {
          return 0;
        }
      },
      isPaused: () => pausedRef.current,
      reload: () => {
        initPlayer();
      },
    }));

    return (
      <div
        ref={outerRef}
        className="w-full h-full bg-black flex items-center justify-center overflow-hidden select-none"
        data-youtube-player="true"
      >
        <div
          className="relative overflow-hidden bg-black"
          style={
            stageSize
              ? { width: `${stageSize.width}px`, height: `${stageSize.height}px` }
              : { width: "100%", height: "100%" }
          }
        >
          {/* Overscan iframe top edge to keep channel title clipped; expose bottom native bar when allowNativeControls is active */}
          <div
            ref={iframeSlotRef}
            className={`absolute inset-x-0 ${
              allowNativeControls ? "pointer-events-auto" : "pointer-events-none"
            }`}
            style={
              allowNativeControls
                ? { top: "-56px", height: "calc(100% + 56px)" }
                : { top: "-92px", height: "calc(100% + 184px)" }
            }
          />

          {/* Hide initial pre-roll title/channel card cleanly until playback begins */}
          {visualState === "loading" && !allowNativeControls && (
            <div className="absolute inset-0 bg-black pointer-events-none z-10" />
          )}

          {/* Hide YouTube's "More videos" / channel shelf when paused (unless user opened native YouTube controls) */}
          {visualState === "paused" && !allowNativeControls && (
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm pointer-events-none z-10" />
          )}

          {/* Hide YouTube's end-screen channel links & suggested videos completely */}
          {visualState === "ended" && (
            <div
              data-interactive="true"
              onClick={(e) => {
                e.stopPropagation();
                playerRef.current?.seekTo(0, true);
                playerRef.current?.playVideo();
              }}
              className="absolute inset-0 bg-black/95 flex flex-col items-center justify-center gap-3 z-20 cursor-pointer"
            >
              <p className="text-sm font-bold text-white">Playback Complete</p>
              <span className="theme-btn-primary px-4 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5">
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Replay Episode</span>
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }
);

YouTubePlayer.displayName = "YouTubePlayer";
