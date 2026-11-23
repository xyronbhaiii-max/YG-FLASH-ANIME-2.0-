import React, { useRef, useState, useEffect, useCallback, useMemo } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Sun,
  Lock,
  Unlock,
  X,
  ArrowLeft,
  Settings,
  Layers,
  ChevronRight,
  Sliders,
  Gauge,
  AlertCircle,
  RefreshCw,
  RotateCwSquare,
  RectangleHorizontal,
  RectangleVertical,
  Languages,
  Check,
  ExternalLink,
} from "lucide-react";
import Hls from "hls.js";
import { useApp, Episode } from "../context/AppContext";
import { getValidAdminIdToken } from "../lib/firebase";
import { subscribeToAnimeEpisodes, fetchAnimeEpisodesOnce, mergeEpisodeLists } from "../lib/firebaseCatalog";
import { classifyStreamUrl } from "../utils/streamUrl";
import {
  getQualityDisplayLabel,
  normalizeQualityCode,
  sortSourcesByQuality,
} from "../utils/videoQuality";
import { StatusBar } from "@capacitor/status-bar";
import { YouTubePlayer, YouTubePlayerHandle } from "../components/YouTubePlayer";
import { VidmolyPlayer, VidmolyPlayerHandle } from "../components/VidmolyPlayer";
import { apiUrl, isCapacitorNative, resolveMediaUrl } from "../utils/apiUrl";
import { sound } from "../utils/sound";

export const VideoPlayerModal: React.FC = () => {
  const {
    activePlayingAnime,
    activePlayingEpisode,
    closePlayback,
    saveWatchProgress,
    startPlayback,
    history,
    isAdmin,
  } = useApp();

  const videoRef = useRef<HTMLVideoElement>(null);
  const ytPlayerRef = useRef<YouTubePlayerHandle>(null);
  const vidmolyPlayerRef = useRef<VidmolyPlayerHandle>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const unlockHideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lockTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const brightnessHudTimerRef = useRef<NodeJS.Timeout | null>(null);
  const feedbackToastTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingAudioToastRef = useRef<string | null>(null);
  const lastTapRef = useRef<number>(0);

  // Preserve time & play state seamlessly across quality/language switches AND initial watch-history resume
  const pendingSeekRef = useRef<number | null>(null);
  const shouldResumeAfterSwitchRef = useRef<boolean>(false);
  const preserveLivePositionRef = useRef<{ sec: number; play: boolean } | null>(null);
  const lastInitializedEpKeyRef = useRef<string | null>(null);
  const lastSavedAtRef = useRef<number>(-999);
  const latestPlaybackRef = useRef<{
    anime: typeof activePlayingAnime;
    episode: typeof activePlayingEpisode;
    curr: number;
    dur: number;
  }>({ anime: null, episode: null, curr: 0, dur: 0 });
  const streamRetryCountRef = useRef<number>(0);
  const triedUrlsRef = useRef<Set<string>>(new Set());
  const enteredFsByRotateRef = useRef<boolean>(false);
  const lastUiTimeUpdateRef = useRef<number>(0);
  const wasInterruptedByOfflineRef = useRef<boolean>(false);
  const bufferingSinceRef = useRef<number | null>(null);
  const stallStepDownCountRef = useRef<number>(0);

  // Left-side brightness swipe gesture refs (pure in-app software brightness)
  const gestureStartRef = useRef<{
    y: number;
    brightness: number;
    active: boolean;
  } | null>(null);
  const isSwipingBrightnessRef = useRef<boolean>(false);
  const skipNextClickRef = useRef<boolean>(false);

  // Player state
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [brightness, setBrightness] = useState<number>(100); // 15% to 160% in-app software brightness
  const [showBrightnessHud, setShowBrightnessHud] = useState<boolean>(false);
  const [showBrightnessPopover, setShowBrightnessPopover] = useState<boolean>(false);
  const [showSpeedPopover, setShowSpeedPopover] = useState<boolean>(false);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [showUnlockButton, setShowUnlockButton] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [orientationMode, setOrientationMode] = useState<"auto" | "vertical" | "horizontal">("auto");
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1280,
    h: typeof window !== "undefined" ? window.innerHeight : 720,
  }));
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [bufferingHint, setBufferingHint] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<{ message: string; code: string } | null>(null);
  const [feedbackToast, setFeedbackToast] = useState<string | null>(null);

  // Pause & Settings Dashboard Modal
  const [showSettingsMenu, setShowSettingsMenu] = useState<boolean>(false);
  const [showEpisodesDrawer, setShowEpisodesDrawer] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [qualityState, setQualityState] = useState<{ epKey: string | null; quality: string }>({
    epKey: null,
    quality: "Auto",
  });
  const [detectedResolution, setDetectedResolution] = useState<string | null>(null);
  const [detectedDimensions, setDetectedDimensions] = useState<{ w: number; h: number } | null>(null);
  const [hlsLevels, setHlsLevels] = useState<
    { index: number; height: number; width: number; bitrate: number; bitrateKbps: number; label: string }[]
  >([]);
  const [selectedHlsLevel, setSelectedHlsLevel] = useState<number>(-1);
  const [activeHlsLevel, setActiveHlsLevel] = useState<number>(-1);
  const [hlsAudioTracks, setHlsAudioTracks] = useState<
    { index: number; name: string; lang: string; default: boolean }[]
  >([]);
  const [selectedHlsAudioTrack, setSelectedHlsAudioTrack] = useState<number>(-1);

  const [hlsRetryNonce, setHlsRetryNonce] = useState<number>(0);
  const [showNativeYtControls, setShowNativeYtControls] = useState<boolean>(false);
  const [fallbackState, setFallbackState] = useState<{ epKey: string | null; url: string } | null>(
    null
  );
  const [fetchedEpisodes, setFetchedEpisodes] = useState<Episode[]>([]);

  const currentEpisodeKey =
    activePlayingAnime && activePlayingEpisode
      ? `${activePlayingAnime.id}::${activePlayingEpisode.id}`
      : null;

  const selectedQuality =
    currentEpisodeKey && qualityState.epKey === currentEpisodeKey ? qualityState.quality : "Auto";
  const authorizedFallbackUrl =
    currentEpisodeKey && fallbackState?.epKey === currentEpisodeKey ? fallbackState.url : null;

  const setSelectedQuality = useCallback(
    (quality: string) => {
      setQualityState({ epKey: currentEpisodeKey, quality });
    },
    [currentEpisodeKey]
  );

  const setAuthorizedFallbackUrl = useCallback(
    (url: string | null) => {
      setFallbackState(url ? { epKey: currentEpisodeKey, url } : null);
    },
    [currentEpisodeKey]
  );

  // Skip indicator ripples (-10s / +10s)
  const [skipRipple, setSkipRipple] = useState<"left" | "right" | null>(null);

  const clearQuickToast = useCallback(() => {
    if (feedbackToastTimerRef.current) {
      clearTimeout(feedbackToastTimerRef.current);
      feedbackToastTimerRef.current = null;
    }
    setFeedbackToast(null);
  }, []);

  const showQuickToast = useCallback((msg: string, durationMs = 2000) => {
    setFeedbackToast(msg);
    if (feedbackToastTimerRef.current) clearTimeout(feedbackToastTimerRef.current);
    feedbackToastTimerRef.current = setTimeout(() => {
      feedbackToastTimerRef.current = null;
      setFeedbackToast(null);
    }, durationMs);
  }, []);

  const updateInAppBrightness = useCallback((nextVal: number) => {
    const clamped = Math.max(15, Math.min(160, Math.round(nextVal)));
    setBrightness(clamped);
    setShowBrightnessHud(true);
    if (brightnessHudTimerRef.current) clearTimeout(brightnessHudTimerRef.current);
    brightnessHudTimerRef.current = setTimeout(() => {
      setShowBrightnessHud(false);
    }, 1200);
  }, []);

  // Autohide controls after exactly 15 seconds of inactivity
  const resetAutohideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (!isLocked && !showSettingsMenu && !showEpisodesDrawer) {
      setShowControls(true);
      hideTimerRef.current = setTimeout(() => {
        setShowControls(false);
      }, 15000); // exactly 15 seconds
    }
  }, [isLocked, showSettingsMenu, showEpisodesDrawer]);

  const scheduleUnlockButtonAutohide = useCallback(() => {
    if (unlockHideTimerRef.current) clearTimeout(unlockHideTimerRef.current);
    unlockHideTimerRef.current = setTimeout(() => {
      setShowUnlockButton(false);
    }, 3500);
  }, []);

  const activateLockMode = useCallback(() => {
    sound.playLock();
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (unlockHideTimerRef.current) clearTimeout(unlockHideTimerRef.current);
    clearQuickToast();
    setIsLocked(true);
    setShowUnlockButton(false);
    setShowControls(false);
    setShowSettingsMenu(false);
    setShowEpisodesDrawer(false);
    setShowBrightnessPopover(false);
    setShowSpeedPopover(false);
  }, [clearQuickToast]);

  const revealUnlockControl = useCallback(() => {
    if (unlockHideTimerRef.current) clearTimeout(unlockHideTimerRef.current);
    setShowUnlockButton((prev) => {
      const next = !prev;
      if (next) {
        scheduleUnlockButtonAutohide();
      }
      return next;
    });
  }, [scheduleUnlockButtonAutohide]);

  const deactivateLockMode = useCallback(() => {
    sound.playLock();
    if (unlockHideTimerRef.current) clearTimeout(unlockHideTimerRef.current);
    setIsLocked(false);
    setShowUnlockButton(false);
    setShowControls(true);
  }, []);

  useEffect(() => {
    resetAutohideTimer();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [resetAutohideTimer]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (unlockHideTimerRef.current) clearTimeout(unlockHideTimerRef.current);
      if (brightnessHudTimerRef.current) clearTimeout(brightnessHudTimerRef.current);
      if (feedbackToastTimerRef.current) clearTimeout(feedbackToastTimerRef.current);
    };
  }, []);

  // Fetch real episodes & subscribe to live Firebase + SSE updates for Episodes Drawer
  useEffect(() => {
    setFetchedEpisodes([]);
    if (!activePlayingAnime?.id) {
      return;
    }
    let cancelled = false;
    let serverEps: Episode[] = [];
    let fbEps: Episode[] = [];
    const syncEpisodes = () => {
      if (!cancelled) {
        setFetchedEpisodes(mergeEpisodeLists(serverEps, fbEps));
      }
    };

    const loadAllEpisodes = async () => {
      const headers: Record<string, string> = {};
      if (isAdmin) {
        const bearerToken = await getValidAdminIdToken(false).catch(() => "");
        if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
      }
      Promise.all([
        fetch(apiUrl(`/api/anime/${activePlayingAnime.id}`), {
          headers,
          credentials: "include",
        })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null),
        fetchAnimeEpisodesOnce(activePlayingAnime.id, isAdmin).catch(() => [] as Episode[]),
      ]).then(([data, fbOnce]) => {
        if (cancelled) return;
        if (Array.isArray(data?.episodes)) {
          serverEps = data.episodes;
        }
        if (fbOnce.length > 0 && fbEps.length === 0) {
          fbEps = fbOnce;
        }
        syncEpisodes();
      });
    };

    void loadAllEpisodes();
    window.addEventListener("yg:catalog-updated", loadAllEpisodes);

    const unsub = subscribeToAnimeEpisodes(
      activePlayingAnime.id,
      isAdmin,
      (fbEpisodes, meta) => {
        if (!cancelled && meta?.hasSnapshot) {
          fbEps = fbEpisodes;
          syncEpisodes();
        }
      }
    );

    return () => {
      cancelled = true;
      window.removeEventListener("yg:catalog-updated", loadAllEpisodes);
      unsub();
    };
  }, [activePlayingAnime?.id, isAdmin]);

  // Always prefer the richest merged snapshot for the currently playing episode (live streaming sources)
  const liveEpisode = useMemo(() => {
    if (!activePlayingEpisode) return null;
    const matched = fetchedEpisodes.find((e) => e.id === activePlayingEpisode.id);
    if (!matched) return activePlayingEpisode;
    return mergeEpisodeLists([activePlayingEpisode], [matched])[0] || matched;
  }, [fetchedEpisodes, activePlayingEpisode]);

  // Build real deduplicated quality sources list for current episode (never contaminate from parent when episode has own sources)
  const availableQualitySources = useMemo(() => {
    const targetEp = liveEpisode || activePlayingEpisode;
    if (!targetEp) return [];
    const rawList: { quality: string; displayLabel: string; label: string; url: string }[] = [];

    if (Array.isArray(targetEp.sources)) {
      for (const s of targetEp.sources) {
        if (s?.url?.trim()) {
          const normQ = normalizeQualityCode(s.quality || s.label);
          const baseLabel = getQualityDisplayLabel(normQ);
          rawList.push({
            quality: normQ,
            displayLabel: baseLabel,
            label: s.label || normQ,
            url: s.url.trim(),
          });
        }
      }
    }

    if (targetEp.videoUrl?.trim()) {
      const primaryUrl = targetEp.videoUrl.trim();
      if (!rawList.some((r) => r.url === primaryUrl)) {
        rawList.unshift({
          quality: "Source",
          displayLabel: "Source Stream",
          label: "Primary Stream",
          url: primaryUrl,
        });
      }
    }

    // Only fall back to parent anime's streamingSources when episode itself has zero valid URLs
    if (rawList.length === 0 && Array.isArray(activePlayingAnime?.streamingSources)) {
      for (const s of activePlayingAnime.streamingSources) {
        if (s?.url?.trim() && !rawList.some((r) => r.url === s.url.trim())) {
          const normQ = normalizeQualityCode(s.quality || s.name);
          rawList.push({
            quality: normQ,
            displayLabel: getQualityDisplayLabel(normQ),
            label: s.name || normQ,
            url: s.url.trim(),
          });
        }
      }
    }

    // Deduplicate by normalized quality code AND distinct URL so fake duplicate-URL tiers are never shown
    const seenQuality = new Set<string>();
    const seenUrls = new Set<string>();
    const deduped = rawList.filter((item) => {
      const qKey = item.quality.toLowerCase();
      if (seenQuality.has(qKey) || seenUrls.has(item.url)) return false;
      seenQuality.add(qKey);
      seenUrls.add(item.url);
      return true;
    });
    return sortSourcesByQuality(deduped);
  }, [liveEpisode, activePlayingEpisode, activePlayingAnime]);

  const availableQualitySourcesRef = useRef(availableQualitySources);
  availableQualitySourcesRef.current = availableQualitySources;
  const showQuickToastRef = useRef(showQuickToast);
  showQuickToastRef.current = showQuickToast;

  // Sibling language tracks belonging to the same anime, season & episode number
  const siblingLanguageVersions = useMemo(() => {
    const targetEp = liveEpisode || activePlayingEpisode;
    if (!targetEp) return [];
    const targetSeason = targetEp.season || 1;
    const targetNum = targetEp.number;
    const matches = fetchedEpisodes.filter(
      (ep) => (ep.season || 1) === targetSeason && ep.number === targetNum
    );
    if (!matches.some((m) => m.id === targetEp.id)) {
      matches.unshift(targetEp);
    }
    return matches;
  }, [fetchedEpisodes, liveEpisode, activePlayingEpisode]);

  // Resolve the active stream URL based on selectedQuality ("Auto" picks adaptive/best available)
  const resolvedStream = useMemo(() => {
    if (availableQualitySources.length === 0) {
      return { url: "", effectiveQuality: detectedResolution || "N/A" };
    }

    if (selectedQuality === "Auto") {
      const conn = (navigator as any).connection;
      const effectiveType: string | undefined = conn?.effectiveType;
      let target = availableQualitySources[0];

      if (effectiveType === "slow-2g" || effectiveType === "2g") {
        target =
          availableQualitySources.find((s) => s.quality === "360p") ||
          availableQualitySources.find((s) => s.quality === "480p") ||
          availableQualitySources[availableQualitySources.length - 1];
      } else if (effectiveType === "3g") {
        target =
          availableQualitySources.find((s) => s.quality === "720p") ||
          availableQualitySources.find((s) => s.quality === "480p") ||
          availableQualitySources[0];
      } else {
        target =
          availableQualitySources.find((s) => s.quality === "1080p") ||
          availableQualitySources[0];
      }

      return {
        url: target.url,
        effectiveQuality: detectedResolution || target.quality,
      };
    }

    const matched = availableQualitySources.find(
      (s) => s.quality.toLowerCase() === selectedQuality.toLowerCase()
    );
    if (matched) {
      return { url: matched.url, effectiveQuality: matched.quality };
    }
    return {
      url: availableQualitySources[0].url,
      effectiveQuality: availableQualitySources[0].quality,
    };
  }, [availableQualitySources, selectedQuality, detectedResolution]);

  const activeStreamUrl = resolveMediaUrl(authorizedFallbackUrl || resolvedStream.url);
  const streamInfo = useMemo(() => classifyStreamUrl(activeStreamUrl), [activeStreamUrl]);

  const findAuthorizedFallbackSource = useCallback(
    (failedUrl: string) => {
      const nonVidmolyAlt = availableQualitySources.find(
        (s) =>
          s.url !== failedUrl &&
          !triedUrlsRef.current.has(s.url) &&
          classifyStreamUrl(s.url).kind !== "vidmoly"
      );
      if (nonVidmolyAlt) {
        return { kind: "quality" as const, quality: nonVidmolyAlt.quality, url: nonVidmolyAlt.url };
      }

      const anyAlt = availableQualitySources.find(
        (s) => s.url !== failedUrl && !triedUrlsRef.current.has(s.url)
      );
      if (anyAlt) {
        return { kind: "quality" as const, quality: anyAlt.quality, url: anyAlt.url };
      }

      const canUseAnimeFilmFallback =
        Boolean(activePlayingEpisode?.id?.startsWith("movie-")) ||
        (fetchedEpisodes.length <= 1 && (activePlayingEpisode?.number ?? 1) === 1);

      if (canUseAnimeFilmFallback && Array.isArray(activePlayingAnime?.streamingSources)) {
        const animeAlt = activePlayingAnime.streamingSources.find((s) => {
          const url = String(s?.url || "").trim();
          if (!url || url === failedUrl || triedUrlsRef.current.has(url)) return false;
          const classified = classifyStreamUrl(url);
          return classified.kind !== "invalid" && classified.kind !== "vidmoly";
        });
        if (animeAlt?.url) {
          return {
            kind: "override" as const,
            quality: normalizeQualityCode(animeAlt.quality || animeAlt.name),
            url: animeAlt.url.trim(),
          };
        }
      }

      return null;
    },
    [availableQualitySources, activePlayingEpisode, fetchedEpisodes.length, activePlayingAnime]
  );

  // Synchronously seed resume seek position BEFORE child YouTubePlayer / <video> effects run
  if (currentEpisodeKey && lastInitializedEpKeyRef.current !== currentEpisodeKey) {
    lastInitializedEpKeyRef.current = currentEpisodeKey;
    lastSavedAtRef.current = -999;
    if (preserveLivePositionRef.current) {
      pendingSeekRef.current = preserveLivePositionRef.current.sec;
      shouldResumeAfterSwitchRef.current = preserveLivePositionRef.current.play;
      preserveLivePositionRef.current = null;
    } else {
      const savedProgress = history.find(
        (h) =>
          h.animeId === activePlayingAnime!.id &&
          (h.episodeId === activePlayingEpisode!.id ||
            (h.episodeNumber === activePlayingEpisode!.number &&
              (h.season || 1) === (activePlayingEpisode!.season || 1) &&
              (!activePlayingEpisode!.language ||
                !h.language ||
                h.language === activePlayingEpisode!.language)))
      );
      if (
        savedProgress &&
        savedProgress.progressSeconds >= 0.5 &&
        (savedProgress.durationSeconds <= 0 ||
          savedProgress.progressSeconds < savedProgress.durationSeconds - 2)
      ) {
        pendingSeekRef.current = savedProgress.progressSeconds;
        shouldResumeAfterSwitchRef.current = true;
      } else {
        pendingSeekRef.current = null;
        shouldResumeAfterSwitchRef.current = false;
      }
    }
  } else if (!currentEpisodeKey && lastInitializedEpKeyRef.current !== null) {
    lastInitializedEpKeyRef.current = null;
    pendingSeekRef.current = null;
  }

  // Reset stream error and detected resolution whenever episode changes
  useEffect(() => {
    setStreamError(null);
    setIsLocked(false);
    setShowUnlockButton(false);
    if (unlockHideTimerRef.current) clearTimeout(unlockHideTimerRef.current);
    setDetectedResolution(null);
    setDetectedDimensions(null);
    setHlsLevels([]);
    setSelectedHlsLevel(-1);
    setActiveHlsLevel(-1);
    setHlsAudioTracks([]);
    setSelectedHlsAudioTrack(-1);
    setHlsRetryNonce(0);
    setShowNativeYtControls(false);
    setCurrentTime(pendingSeekRef.current || 0);
    setDuration(0);
    latestPlaybackRef.current = {
      anime: activePlayingAnime,
      episode: liveEpisode || activePlayingEpisode,
      curr: pendingSeekRef.current || 0,
      dur: 0,
    };
    streamRetryCountRef.current = 0;
    triedUrlsRef.current.clear();
    if (pendingAudioToastRef.current) {
      const pendingMsg = pendingAudioToastRef.current;
      pendingAudioToastRef.current = null;
      showQuickToast(pendingMsg, 2000);
    } else if (pendingSeekRef.current && pendingSeekRef.current >= 0.5) {
      const m = Math.floor(pendingSeekRef.current / 60);
      const s = Math.floor(pendingSeekRef.current % 60);
      showQuickToast(`Resuming from ${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`);
    } else {
      clearQuickToast();
    }
  }, [currentEpisodeKey, clearQuickToast, showQuickToast]);

  // Report immediate invalid URL errors without sending malformed/non-video links to <video>
  useEffect(() => {
    if (activeStreamUrl && streamInfo.kind === "invalid") {
      setIsBuffering(false);
      setIsPlaying(false);
      setStreamError({
        code: "STREAM_URL_INVALID",
        message:
          streamInfo.error || "Invalid streaming URL. Please verify the video link in Admin Studio.",
      });
    }
  }, [activeStreamUrl, streamInfo]);

  // Attach HLS (.m3u8) stream (Bunny Stream VOD ABR + Safari Native HLS fallback) to <video>
  useEffect(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    setHlsLevels([]);
    setSelectedHlsLevel(-1);
    setActiveHlsLevel(-1);
    setHlsAudioTracks([]);
    setSelectedHlsAudioTrack(-1);

    if (streamInfo.kind !== "hls" || !streamInfo.url || !videoRef.current) {
      return;
    }

    const video = videoRef.current;
    let hlsRecoveryAttempts = 0;
    setIsBuffering(true);
    setStreamError(null);

    if (Hls.isSupported()) {
      const connType: string | undefined = (navigator as any).connection?.effectiveType;
      const defaultAbrEstimate =
        connType === "slow-2g" || connType === "2g"
          ? 450_000
          : connType === "3g"
          ? 1_200_000
          : 3_500_000;

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: false,
        startLevel: -1,
        abrEwmaDefaultEstimate: defaultAbrEstimate,
        maxBufferLength: 24,
        maxMaxBufferLength: 60,
        manifestLoadingTimeOut: 20000,
        levelLoadingTimeOut: 20000,
        fragLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 6,
        nudgeMaxRetry: 6,
      });
      hls.subtitleDisplay = false;
      hlsRef.current = hls;

      const updateResolutionFromLevel = (lvlIndex: number) => {
        if (typeof lvlIndex !== "number" || lvlIndex < 0) return;
        setActiveHlsLevel(lvlIndex);
        const lvl = hls.levels?.[lvlIndex];
        if (lvl?.height && lvl.height > 0) {
          setDetectedResolution(`${lvl.height}p`);
        }
        if (lvl?.width && lvl?.height) {
          setDetectedDimensions({ w: lvl.width, h: lvl.height });
        }
      };

      const syncAudioTracks = () => {
        const tracks = (hls.audioTracks || []).map((t, idx) => ({
          index: idx,
          name: String(t.name || t.lang || `Audio ${idx + 1}`),
          lang: String(t.lang || ""),
          default: Boolean(t.default),
        }));
        setHlsAudioTracks(tracks);
        if (typeof hls.audioTrack === "number" && hls.audioTrack >= 0) {
          setSelectedHlsAudioTrack(hls.audioTrack);
        } else if (tracks.length > 0) {
          const defIdx = tracks.findIndex((t) => t.default);
          setSelectedHlsAudioTrack(defIdx >= 0 ? defIdx : 0);
        }
      };

      hls.loadSource(streamInfo.url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStreamError(null);
        const parsedLevels = (hls.levels || [])
          .map((lvl, idx) => {
            const bw = lvl.bitrate || 0;
            const bitrateKbps = bw > 0 ? Math.max(1, Math.round(bw / 1000)) : 0;
            return {
              index: idx,
              height: lvl.height || 0,
              width: lvl.width || 0,
              bitrate: bw,
              bitrateKbps,
              label:
                lvl.height > 0
                  ? `${lvl.height}p`
                  : bitrateKbps > 0
                  ? `${bitrateKbps} kbps`
                  : `Level ${idx + 1}`,
            };
          })
          .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);

        const seenLabels = new Set<string>();
        const uniqueLevels = parsedLevels.filter((lvl) => {
          const dedupeKey = lvl.height > 0 ? lvl.label : `${lvl.label}-${lvl.index}`;
          if (seenLabels.has(dedupeKey)) return false;
          seenLabels.add(dedupeKey);
          return true;
        });
        setHlsLevels(uniqueLevels);
        setSelectedHlsLevel(-1);
        setActiveHlsLevel(hls.currentLevel);

        if (uniqueLevels.length === 1) {
          if (uniqueLevels[0].height > 0) {
            setDetectedResolution(uniqueLevels[0].label);
          }
          if (uniqueLevels[0].width > 0 && uniqueLevels[0].height > 0) {
            setDetectedDimensions({ w: uniqueLevels[0].width, h: uniqueLevels[0].height });
          }
        }

        syncAudioTracks();

        if (
          pendingSeekRef.current !== null &&
          !isNaN(pendingSeekRef.current) &&
          pendingSeekRef.current > 0 &&
          video.readyState >= 1
        ) {
          video.currentTime = pendingSeekRef.current;
          pendingSeekRef.current = null;
        }
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncAudioTracks);
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
        if (typeof data?.id === "number") {
          setSelectedHlsAudioTrack(data.id);
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        updateResolutionFromLevel(data.level);
      });

      hls.on(Hls.Events.FRAG_CHANGED, (_event, data) => {
        if (typeof data?.frag?.level === "number") {
          updateResolutionFromLevel(data.frag.level);
        }
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        setIsBuffering(false);
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
          if (
            data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
            data.details === Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE
          ) {
            setIsBuffering(true);
          }
          return;
        }

        const httpStatus = data.response?.code;
        const isAuthOrMissingHttp =
          httpStatus === 401 || httpStatus === 403 || httpStatus === 404 || httpStatus === 410;

        if (!isAuthOrMissingHttp) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && hlsRecoveryAttempts < 3) {
            hlsRecoveryAttempts += 1;
            setIsBuffering(true);
            setTimeout(() => {
              if (hlsRef.current === hls) {
                try {
                  hls.startLoad();
                } catch {}
              }
            }, 700);
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hlsRecoveryAttempts < 2) {
            hlsRecoveryAttempts += 1;
            hls.recoverMediaError();
            return;
          }
        }

        hls.destroy();
        hlsRef.current = null;

        triedUrlsRef.current.add(streamInfo.url);
        const fallbackSource = availableQualitySourcesRef.current.find(
          (s) => s.url !== streamInfo.url && !triedUrlsRef.current.has(s.url)
        );
        if (fallbackSource) {
          pendingSeekRef.current = video.currentTime || 0;
          shouldResumeAfterSwitchRef.current = true;
          setSelectedQuality(fallbackSource.quality);
          showQuickToastRef.current(`Switched to ${fallbackSource.quality} for smooth streaming`);
          return;
        }

        setIsBuffering(false);
        setIsPlaying(false);
        const hlsCode = httpStatus
          ? `HLS_HTTP_${httpStatus}`
          : data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? "HLS_NETWORK_ERROR"
          : data.type === Hls.ErrorTypes.MEDIA_ERROR
          ? "HLS_MEDIA_ERROR"
          : "HLS_STREAM_ERROR";

        const errorMessage =
          httpStatus === 403
            ? "Access denied (HTTP 403) by CDN. Check Bunny Stream Allowed Domains / Referrer whitelist or verify signed Token Authentication has not expired."
            : httpStatus === 401
            ? "Unauthorized (HTTP 401). Verify Bunny Stream Token Authentication parameters."
            : httpStatus === 404 || httpStatus === 410
            ? "HLS playlist or media segment not found (HTTP 404). Verify the Bunny Stream .m3u8 URL and encoding status."
            : "Unable to load this HLS (.m3u8) stream. Verify the stream URL or your network connection.";

        setStreamError({
          code: hlsCode,
          message: errorMessage,
        });
      });

      return () => {
        hls.destroy();
        if (hlsRef.current === hls) hlsRef.current = null;
      };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamInfo.url;
      video.load();
      video.play().catch(() => {});
      return () => {
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    } else {
      setIsBuffering(false);
      setStreamError({
        code: "HLS_UNSUPPORTED",
        message: "HLS (.m3u8) streaming is not supported in this browser.",
      });
    }
  }, [streamInfo.kind, streamInfo.url, hlsRetryNonce, setSelectedQuality]);

  // Continuously enforce playbackSpeed & volume on the active player
  useEffect(() => {
    if (streamInfo.kind === "youtube") {
      ytPlayerRef.current?.setPlaybackRate(playbackSpeed);
      ytPlayerRef.current?.setVolume(volume);
      ytPlayerRef.current?.setMuted(isMuted);
    } else if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed;
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [playbackSpeed, volume, isMuted, activeStreamUrl, activePlayingEpisode?.id, streamInfo.kind]);

  // Fullscreen, offline-pause, & auto-resume listeners
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    const handleOfflinePause = () => {
      const videoWasPlaying = Boolean(videoRef.current && !videoRef.current.paused);
      const ytWasPlaying = Boolean(
        streamInfo.kind === "youtube" && ytPlayerRef.current && !ytPlayerRef.current.isPaused()
      );
      if (videoWasPlaying || ytWasPlaying) {
        wasInterruptedByOfflineRef.current = true;
      }
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      ytPlayerRef.current?.pause();
      setIsPlaying(false);
    };
    const handleNetworkRestored = () => {
      if (!wasInterruptedByOfflineRef.current) return;
      wasInterruptedByOfflineRef.current = false;
      setStreamError(null);
      if (streamInfo.kind === "hls" && hlsRef.current) {
        try {
          hlsRef.current.startLoad();
        } catch {}
      }
      if (streamInfo.kind === "youtube") {
        ytPlayerRef.current?.play();
        setIsPlaying(true);
      } else if (videoRef.current) {
        videoRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    };
    const handleResize = () => {
      setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    window.addEventListener("yg:offline-pause", handleOfflinePause);
    window.addEventListener("yg:network-restored", handleNetworkRestored);
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      document.removeEventListener("fullscreenchange", handleFsChange);
      window.removeEventListener("yg:offline-pause", handleOfflinePause);
      window.removeEventListener("yg:network-restored", handleNetworkRestored);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
      try {
        (screen as any).orientation?.unlock?.();
      } catch {}
    };
  }, [streamInfo.kind]);

  // Monitor prolonged buffering on slow networks and step down Auto ABR level cleanly
  useEffect(() => {
    if (!isBuffering || streamError) {
      bufferingSinceRef.current = null;
      setBufferingHint(null);
      return;
    }
    bufferingSinceRef.current = Date.now();
    const timer = setTimeout(() => {
      const hls = hlsRef.current;
      if (
        hls &&
        selectedHlsLevel === -1 &&
        hls.levels &&
        hls.levels.length > 1 &&
        stallStepDownCountRef.current < 3
      ) {
        const currentLvl = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
        if (typeof currentLvl === "number" && currentLvl > 0) {
          const lowerLevel = currentLvl - 1;
          hls.nextLoadLevel = lowerLevel;
          hls.loadLevel = lowerLevel;
          stallStepDownCountRef.current += 1;
          const lowerH = hls.levels[lowerLevel]?.height;
          setBufferingHint(
            lowerH ? `Adjusting to ${lowerH}p for slow network...` : "Adjusting quality for slow network..."
          );
        } else {
          setBufferingHint("Slow connection detected, buffering...");
        }
      } else {
        setBufferingHint("Slow connection detected, buffering...");
      }
    }, 4500);
    return () => clearTimeout(timer);
  }, [isBuffering, streamError, selectedHlsLevel]);

  // Manage Android StatusBar visibility cleanly in fullscreen / rotated landscape playback
  useEffect(() => {
    if (!isCapacitorNative()) return;
    if (isFullscreen || orientationMode === "horizontal") {
      StatusBar.hide().catch(() => {});
    } else {
      StatusBar.show().catch(() => {});
    }
    return () => {
      StatusBar.show().catch(() => {});
    };
  }, [isFullscreen, orientationMode]);

  const persistWatchProgress = useCallback(
    (curr: number, dur: number, force = false) => {
      if (!activePlayingAnime || !activePlayingEpisode) return;
      const roundedCurr = Math.round(curr * 10) / 10;
      const roundedDur = Math.round(dur * 10) / 10;
      latestPlaybackRef.current = {
        anime: activePlayingAnime,
        episode: activePlayingEpisode,
        curr: roundedCurr,
        dur: roundedDur,
      };
      if (roundedCurr < 0.3) return;
      if (force || Math.abs(roundedCurr - lastSavedAtRef.current) >= 4) {
        lastSavedAtRef.current = roundedCurr;
        saveWatchProgress(
          {
            animeId: activePlayingAnime.id,
            animeTitle: activePlayingAnime.title,
            episodeId: activePlayingEpisode.id,
            episodeNumber: activePlayingEpisode.number,
            episodeTitle: activePlayingEpisode.title,
            season: activePlayingEpisode.season || 1,
            language: activePlayingEpisode.language || "Japanese",
            poster: activePlayingAnime.posterImage,
            progressSeconds: roundedCurr,
            durationSeconds: roundedDur,
          },
          { force }
        );
      }
    },
    [saveWatchProgress, activePlayingAnime, activePlayingEpisode]
  );

  const flushCurrentProgress = useCallback(() => {
    if (!activePlayingAnime || !activePlayingEpisode) return;
    let curr = latestPlaybackRef.current.curr;
    let dur = latestPlaybackRef.current.dur;
    if (streamInfo.kind === "youtube" && ytPlayerRef.current) {
      const ytCurr = ytPlayerRef.current.getCurrentTime();
      const ytDur = ytPlayerRef.current.getDuration();
      if (ytCurr > 0) curr = ytCurr;
      if (ytDur > 0) dur = ytDur;
    } else if (videoRef.current) {
      if (videoRef.current.currentTime > 0) curr = videoRef.current.currentTime;
      if (videoRef.current.duration > 0) dur = videoRef.current.duration;
    }
    persistWatchProgress(curr, dur, true);
  }, [activePlayingAnime, activePlayingEpisode, persistWatchProgress, streamInfo.kind]);

  const flushCurrentProgressRef = useRef(flushCurrentProgress);
  flushCurrentProgressRef.current = flushCurrentProgress;

  // Persist exact playback progress automatically if user switches apps, closes tab, or unmounts
  useEffect(() => {
    const handleVisibilityOrUnload = () => {
      if (document.visibilityState === "hidden") {
        flushCurrentProgressRef.current();
      }
    };
    const handlePageHide = () => flushCurrentProgressRef.current();
    document.addEventListener("visibilitychange", handleVisibilityOrUnload);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);
    return () => {
      flushCurrentProgressRef.current();
      document.removeEventListener("visibilitychange", handleVisibilityOrUnload);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
    };
  }, []);

  const handleClosePlayback = useCallback(() => {
    flushCurrentProgress();
    if (unlockHideTimerRef.current) clearTimeout(unlockHideTimerRef.current);
    pendingAudioToastRef.current = null;
    clearQuickToast();
    setIsLocked(false);
    setShowUnlockButton(false);
    setOrientationMode("auto");
    enteredFsByRotateRef.current = false;
    try {
      (screen as any).orientation?.unlock?.();
    } catch {}
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    closePlayback();
  }, [closePlayback, flushCurrentProgress, clearQuickToast]);

  const togglePlayRef = useRef<() => void>(() => {});
  const seekRelativeRef = useRef<(delta: number) => void>(() => {});

  // Keyboard controls (uses fresh refs so handlers never capture stale episode/playback closures)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isLocked) {
        if (e.key === "Escape") {
          e.preventDefault();
          revealUnlockControl();
        }
        return;
      }
      if (e.key === "Escape") {
        if (showSettingsMenu) {
          setShowSettingsMenu(false);
        } else if (showEpisodesDrawer) {
          setShowEpisodesDrawer(false);
        } else if (isFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else {
          handleClosePlayback();
        }
      } else if (e.key === " " || e.key === "k") {
        if (streamInfo.kind === "vidmoly") return;
        e.preventDefault();
        togglePlayRef.current();
      } else if (e.key === "ArrowLeft") {
        if (streamInfo.kind === "vidmoly") return;
        seekRelativeRef.current(-10);
      } else if (e.key === "ArrowRight") {
        if (streamInfo.kind === "vidmoly") return;
        seekRelativeRef.current(10);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    const handleAndroidBack = (ev: Event) => {
      ev.preventDefault();
      if (isLocked) {
        revealUnlockControl();
        return;
      }
      if (showSettingsMenu) {
        setShowSettingsMenu(false);
      } else if (showEpisodesDrawer) {
        setShowEpisodesDrawer(false);
      } else if (isFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else {
        handleClosePlayback();
      }
    };
    window.addEventListener("yg:android-back", handleAndroidBack);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("yg:android-back", handleAndroidBack);
    };
  }, [isLocked, revealUnlockControl, isFullscreen, showSettingsMenu, showEpisodesDrawer, handleClosePlayback, streamInfo.kind]);

  const effectiveOrientation: "vertical" | "horizontal" =
    orientationMode === "auto"
      ? viewportSize.w > viewportSize.h
        ? "horizontal"
        : "vertical"
      : orientationMode;
  const isCssRotatedLandscape =
    orientationMode === "horizontal" && viewportSize.w < viewportSize.h;
  const isPortraitConstrained =
    orientationMode === "vertical" && viewportSize.w > viewportSize.h;

  if (!activePlayingAnime || !activePlayingEpisode) return null;

  const togglePlay = () => {
    sound.playClick();
    if (streamInfo.kind === "youtube") {
      const yt = ytPlayerRef.current;
      if (!yt) return;
      if (yt.isPaused() || !isPlaying) {
        yt.play();
        setIsPlaying(true);
      } else {
        yt.pause();
        setIsPlaying(false);
      }
      resetAutohideTimer();
      return;
    }

    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
    resetAutohideTimer();
  };

  const seekRelative = (delta: number) => {
    sound.playClick();
    if (streamInfo.kind === "youtube") {
      const yt = ytPlayerRef.current;
      if (!yt) return;
      const base = yt.getCurrentTime() || currentTime;
      const total = yt.getDuration() || duration;
      const target = Math.max(0, Math.min(base + delta, total || base + Math.max(0, delta)));
      yt.seekTo(target);
      setCurrentTime(target);
      persistWatchProgress(target, total, true);
      setSkipRipple(delta < 0 ? "left" : "right");
      setTimeout(() => setSkipRipple(null), 700);
      resetAutohideTimer();
      return;
    }

    if (!videoRef.current) return;
    const nextPos = Math.max(0, Math.min(videoRef.current.currentTime + delta, duration || videoRef.current.currentTime + Math.max(0, delta)));
    videoRef.current.currentTime = nextPos;
    lastUiTimeUpdateRef.current = nextPos;
    setCurrentTime(nextPos);
    persistWatchProgress(nextPos, duration || videoRef.current.duration || 0, true);
    setSkipRipple(delta < 0 ? "left" : "right");
    setTimeout(() => setSkipRipple(null), 700);
    resetAutohideTimer();
  };

  togglePlayRef.current = togglePlay;
  seekRelativeRef.current = seekRelative;

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const curr = videoRef.current.currentTime;
    const dur = videoRef.current.duration || 0;
    if (!videoRef.current.paused && isBuffering && curr > lastUiTimeUpdateRef.current) {
      setIsBuffering(false);
      stallStepDownCountRef.current = 0;
    }
    if (Math.abs(curr - lastUiTimeUpdateRef.current) >= 0.35 || curr === 0) {
      lastUiTimeUpdateRef.current = curr;
      setCurrentTime(curr);
    }
    if (dur > 0 && Math.abs(dur - duration) >= 0.5) {
      setDuration(dur);
    }
    persistWatchProgress(curr, dur);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = parseFloat(e.target.value);
    lastUiTimeUpdateRef.current = targetTime;
    if (streamInfo.kind === "youtube") {
      ytPlayerRef.current?.seekTo(targetTime);
      setCurrentTime(targetTime);
      persistWatchProgress(targetTime, duration, true);
    } else if (videoRef.current) {
      videoRef.current.currentTime = targetTime;
      setCurrentTime(targetTime);
      persistWatchProgress(targetTime, duration || videoRef.current.duration || 0, true);
    }
    resetAutohideTimer();
  };

  const toggleFullscreen = () => {
    sound.playClick();
    const targetEl = fullscreenRef.current || containerRef.current;
    if (!targetEl) return;
    if (!document.fullscreenElement) {
      enteredFsByRotateRef.current = false;
      targetEl.requestFullscreen().catch(() => {});
    } else {
      enteredFsByRotateRef.current = false;
      document.exitFullscreen().catch(() => {});
    }
  };

  const toggleScreenOrientation = async (target?: "vertical" | "horizontal") => {
    const nextMode =
      target || (effectiveOrientation === "vertical" ? "horizontal" : "vertical");
    sound.playClick();
    setOrientationMode(nextMode);
    const orient = (screen as any).orientation;

    if (nextMode === "horizontal") {
      try {
        const targetEl = fullscreenRef.current || containerRef.current;
        if (!document.fullscreenElement && targetEl?.requestFullscreen) {
          enteredFsByRotateRef.current = true;
          await targetEl.requestFullscreen().catch(() => {});
        }
      } catch {}
      try {
        if (orient?.lock) {
          await orient.lock("landscape").catch(() => {});
        }
      } catch {}
      showQuickToast("Horizontal View");
    } else {
      try {
        if (orient?.lock) {
          await orient.lock("portrait").catch(() => {});
        }
        orient?.unlock?.();
      } catch {}
      try {
        if (enteredFsByRotateRef.current && document.fullscreenElement) {
          enteredFsByRotateRef.current = false;
          await document.exitFullscreen().catch(() => {});
        }
      } catch {}
      showQuickToast("Vertical View");
    }
    resetAutohideTimer();
  };

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const handleSpeedChange = (speed: number) => {
    setPlaybackSpeed(speed);
    if (streamInfo.kind === "youtube") {
      ytPlayerRef.current?.setPlaybackRate(speed);
    } else if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
    sound.playClick();
    showQuickToast(`Playback Speed: ${speed}x`);
  };

  const handleLanguageSwitch = (targetEp: Episode) => {
    if (!activePlayingAnime || targetEp.id === activePlayingEpisode?.id) return;
    sound.playClick();
    let liveSec = currentTime;
    let wasPlaying = isPlaying;
    if (streamInfo.kind === "youtube" && ytPlayerRef.current) {
      liveSec = ytPlayerRef.current.getCurrentTime() || liveSec;
      wasPlaying = !ytPlayerRef.current.isPaused();
    } else if (videoRef.current) {
      liveSec = videoRef.current.currentTime || liveSec;
      wasPlaying = !videoRef.current.paused;
    }
    flushCurrentProgress();
    preserveLivePositionRef.current = {
      sec: Math.max(0, liveSec),
      play: wasPlaying,
    };
    pendingAudioToastRef.current = `Audio: ${targetEp.language || "Japanese"}`;
    setShowSettingsMenu(false);
    startPlayback(activePlayingAnime, targetEp);
  };

  const handleQualityChange = (quality: string) => {
    if (quality === selectedQuality) return;
    sound.playClick();

    // Determine what URL the new quality will resolve to
    let nextUrl = activeStreamUrl;
    if (quality === "Auto") {
      nextUrl =
        (availableQualitySources.find((s) => s.quality === "1080p") || availableQualitySources[0])
          ?.url || "";
    } else {
      nextUrl =
        availableQualitySources.find((s) => s.quality.toLowerCase() === quality.toLowerCase())
          ?.url || activeStreamUrl;
    }

    if (nextUrl && nextUrl !== activeStreamUrl) {
      if (streamInfo.kind === "youtube" && ytPlayerRef.current) {
        pendingSeekRef.current = ytPlayerRef.current.getCurrentTime();
        shouldResumeAfterSwitchRef.current = !ytPlayerRef.current.isPaused();
      } else if (videoRef.current) {
        pendingSeekRef.current = videoRef.current.currentTime;
        shouldResumeAfterSwitchRef.current = !videoRef.current.paused;
      }
    } else {
      pendingSeekRef.current = null;
    }

    setAuthorizedFallbackUrl(null);
    setStreamError(null);
    setSelectedQuality(quality);
    showQuickToast(
      quality === "Auto"
        ? `Quality: Auto (${resolvedStream.effectiveQuality})`
        : `Quality: Manual · ${getQualityDisplayLabel(quality)}`
    );
  };

  const handleHlsLevelChange = (levelIndex: number) => {
    sound.playClick();
    setSelectedHlsLevel(levelIndex);
    if (hlsRef.current) {
      if (levelIndex === -1) {
        hlsRef.current.currentLevel = -1;
        hlsRef.current.nextLevel = -1;
        hlsRef.current.loadLevel = -1;
      } else {
        // Lock both active playback level and upcoming segment loader cleanly without restarting video
        hlsRef.current.nextLevel = levelIndex;
        hlsRef.current.loadLevel = levelIndex;
        hlsRef.current.currentLevel = levelIndex;
      }
    }
    if (levelIndex === -1) {
      showQuickToast("Quality: Auto (HLS Adaptive)");
    } else {
      const opt = hlsLevels.find((l) => l.index === levelIndex);
      if (opt) {
        setActiveHlsLevel(levelIndex);
        if (opt.height > 0) setDetectedResolution(`${opt.height}p`);
        if (opt.width > 0 && opt.height > 0) setDetectedDimensions({ w: opt.width, h: opt.height });
      }
      showQuickToast(`Quality: Manual · ${opt?.label || "Custom"}`);
    }
  };

  const handleHlsAudioTrackChange = (trackIndex: number) => {
    if (trackIndex < 0 || trackIndex === selectedHlsAudioTrack) return;
    sound.playClick();
    setSelectedHlsAudioTrack(trackIndex);
    if (hlsRef.current) {
      hlsRef.current.audioTrack = trackIndex;
    }
    const track = hlsAudioTracks.find((t) => t.index === trackIndex);
    const label = track?.name || track?.lang || "Selected";
    showQuickToast(`Audio: ${label}`, 2000);
  };

  // Open Pause & Settings Dashboard
  const openPauseSettingsDashboard = () => {
    sound.playClick();
    setShowBrightnessPopover(false);
    setShowSpeedPopover(false);
    if (streamInfo.kind === "youtube") {
      ytPlayerRef.current?.pause();
      setIsPlaying(false);
    } else if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
    setShowControls(true);
    setShowSettingsMenu(true);
  };

  // Resume from Pause & Settings Dashboard
  const resumeFromDashboard = () => {
    sound.playClick();
    setShowSettingsMenu(false);
    if (streamInfo.kind === "youtube") {
      ytPlayerRef.current?.play();
      setIsPlaying(true);
    } else if (videoRef.current && videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
    resetAutohideTimer();
  };

  // Gesture Handlers: Left-side vertical swipe / drag for MovieBox-inspired In-App Brightness
  const startLeftBrightnessGesture = (clientX: number, clientY: number, target: HTMLElement) => {
    if (
      streamInfo.kind === "vidmoly" ||
      isLocked ||
      showSettingsMenu ||
      showEpisodesDrawer ||
      target.closest("button") ||
      target.closest("input") ||
      target.closest("[data-interactive='true']")
    ) {
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (isCssRotatedLandscape) {
      const relativeLeft = clientY - (rect?.top || 0);
      const rotatedWidth = rect?.height || viewportSize.h;
      if (relativeLeft <= rotatedWidth * 0.45) {
        gestureStartRef.current = {
          y: clientX,
          brightness,
          active: true,
        };
        isSwipingBrightnessRef.current = false;
      }
      return;
    }

    const containerWidth = rect?.width || window.innerWidth;
    const relativeX = clientX - (rect?.left || 0);

    // Activate vertical brightness swipe only on left 45% side of the player canvas
    if (relativeX <= containerWidth * 0.45) {
      gestureStartRef.current = {
        y: clientY,
        brightness,
        active: true,
      };
      isSwipingBrightnessRef.current = false;
    }
  };

  const moveLeftBrightnessGesture = (clientX: number, clientY: number) => {
    const start = gestureStartRef.current;
    if (!start || !start.active) return;

    const deltaY = isCssRotatedLandscape ? clientX - start.y : start.y - clientY; // dragging up = positive = brighter
    if (!isSwipingBrightnessRef.current && Math.abs(deltaY) > 12) {
      isSwipingBrightnessRef.current = true;
    }

    if (isSwipingBrightnessRef.current) {
      const containerHeight = isCssRotatedLandscape
        ? viewportSize.w
        : containerRef.current?.clientHeight || window.innerHeight || 500;
      const sensitivity = 160 / Math.max(220, containerHeight * 0.6);
      updateInAppBrightness(start.brightness + deltaY * sensitivity);
    }
  };

  const endLeftBrightnessGesture = () => {
    if (isSwipingBrightnessRef.current) {
      skipNextClickRef.current = true;
      setTimeout(() => {
        skipNextClickRef.current = false;
      }, 80);
    }
    gestureStartRef.current = null;
    isSwipingBrightnessRef.current = false;
  };

  // Click & Double-Tap (2 Clicks) Handler
  const handleCanvasInteraction = (e: React.MouseEvent | React.TouchEvent) => {
    if (skipNextClickRef.current) {
      skipNextClickRef.current = false;
      return;
    }

    const target = e.target as HTMLElement;
    // Ignore clicks inside buttons, sliders, or modals
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest("[data-interactive='true']")
    ) {
      return;
    }

    if (showBrightnessPopover) {
      setShowBrightnessPopover(false);
    }
    if (showSpeedPopover) {
      setShowSpeedPopover(false);
    }

    if (isLocked) {
      // While screen is locked, a single tap reveals only the small Unlock button (never unlocks automatically)
      revealUnlockControl();
      return;
    }

    const now = Date.now();
    const timeDiff = now - lastTapRef.current;
    lastTapRef.current = now;

    if (timeDiff < 320) {
      // 2 CLICKS / DOUBLE TAP DETECTED -> Open Pause & Settings Dashboard!
      lastTapRef.current = 0;
      openPauseSettingsDashboard();
    } else {
      // 1 CLICK -> Toggle controls bar
      setShowControls((prev) => !prev);
      resetAutohideTimer();
    }
  };

  // Compute dual-layer software brightness:
  // - Above 100%: boost video luminance via CSS filter
  // - Below 100%: smooth cinema black scrim overlay (deep dimming without washing blacks)
  const videoBoostBrightness = brightness > 100 ? brightness : 100;
  const softwareDimOpacity =
    brightness < 100 ? Math.min(0.85, ((100 - brightness) / 85) * 0.85) : 0;
  const brightnessBarPercent = Math.round(((brightness - 15) / (160 - 15)) * 100);

  return (
    <div
      ref={fullscreenRef}
      className="yg-player-surface fixed inset-0 z-50 bg-black flex items-center justify-center select-none overflow-hidden"
    >
      <div
        ref={containerRef}
        onMouseMove={(e) => {
          resetAutohideTimer();
          moveLeftBrightnessGesture(e.clientX, e.clientY);
        }}
        onMouseDown={(e) => startLeftBrightnessGesture(e.clientX, e.clientY, e.target as HTMLElement)}
        onMouseUp={endLeftBrightnessGesture}
        onMouseLeave={endLeftBrightnessGesture}
        onTouchStart={(e) => {
          if (e.touches.length === 1) {
            startLeftBrightnessGesture(
              e.touches[0].clientX,
              e.touches[0].clientY,
              e.target as HTMLElement
            );
          }
        }}
        onTouchMove={(e) => {
          if (e.touches.length === 1) {
            moveLeftBrightnessGesture(e.touches[0].clientX, e.touches[0].clientY);
          }
        }}
        onTouchEnd={endLeftBrightnessGesture}
        onClick={handleCanvasInteraction}
        onDoubleClick={(e) => {
          if (isLocked || skipNextClickRef.current) return;
          // Native double-click fallback
          const target = e.target as HTMLElement;
          if (!target.closest("button") && !target.closest("input") && !target.closest("[data-interactive='true']")) {
            openPauseSettingsDashboard();
          }
        }}
        style={
          isCssRotatedLandscape
            ? {
                position: "fixed",
                top: "50%",
                left: "50%",
                width: `${viewportSize.h}px`,
                height: `${viewportSize.w}px`,
                transform: "translate(-50%, -50%) rotate(90deg)",
              }
            : undefined
        }
        className={`relative bg-black flex items-center justify-center select-none overflow-hidden ${
          isCssRotatedLandscape
            ? "touch-none"
            : isPortraitConstrained
            ? "w-full max-w-[430px] h-full border-x border-white/15 touch-pan-x"
            : "w-full h-full touch-pan-x"
        }`}
      >
        {/* 16:9 Video Canvas Container */}
        <div
          className="relative w-full h-full max-h-screen aspect-video flex items-center justify-center overflow-hidden cursor-pointer"
          style={{ filter: `brightness(${videoBoostBrightness}%)` }}
        >
        {activeStreamUrl ? (
          streamInfo.kind === "youtube" && streamInfo.youtubeId ? (
            <YouTubePlayer
              key={streamInfo.youtubeId}
              ref={ytPlayerRef}
              videoId={streamInfo.youtubeId}
              volume={volume}
              isMuted={isMuted}
              playbackRate={playbackSpeed}
              initialSeekSeconds={pendingSeekRef.current}
              allowNativeControls={showNativeYtControls}
              onPlayChange={(playing) => {
                setIsPlaying(playing);
                if (!playing && ytPlayerRef.current) {
                  persistWatchProgress(
                    ytPlayerRef.current.getCurrentTime(),
                    ytPlayerRef.current.getDuration(),
                    true
                  );
                }
              }}
              onBufferingChange={(buffering) => setIsBuffering(buffering)}
              onTimeUpdate={(curr, dur) => {
                setCurrentTime(curr);
                setDuration(dur);
                persistWatchProgress(curr, dur);
              }}
              onReady={(dur) => {
                if (dur > 0) setDuration(dur);
                pendingSeekRef.current = null;
                setStreamError(null);
              }}
              onError={(ytMessage, ytCode) => {
                triedUrlsRef.current.add(activeStreamUrl);
                const fallbackSource = availableQualitySources.find(
                  (s) => s.url !== activeStreamUrl && !triedUrlsRef.current.has(s.url)
                );
                if (fallbackSource) {
                  setSelectedQuality(fallbackSource.quality);
                  showQuickToast(`Switched to ${fallbackSource.quality} for smooth streaming`);
                  return;
                }
                setIsBuffering(false);
                setIsPlaying(false);
                const resolvedCode =
                  typeof ytCode === "number"
                    ? `YT_ERR_${ytCode}`
                    : ytCode
                    ? String(ytCode).toUpperCase()
                    : "YT_PLAYBACK_ERROR";
                setStreamError({ code: resolvedCode, message: ytMessage });
              }}
            />
          ) : streamInfo.kind === "vidmoly" && streamInfo.embedUrl && streamInfo.vidmolyId ? (
            <VidmolyPlayer
              key={`${streamInfo.embedUrl}::${activePlayingEpisode.id}`}
              ref={vidmolyPlayerRef}
              embedUrl={streamInfo.embedUrl}
              vidmolyId={streamInfo.vidmolyId}
              onBufferingChange={(buffering) => setIsBuffering(buffering)}
              onReady={() => {
                setStreamError(null);
                setIsBuffering(false);
              }}
              onError={(vmMessage, vmCode) => {
                triedUrlsRef.current.add(activeStreamUrl);
                const fallback = findAuthorizedFallbackSource(activeStreamUrl);
                if (fallback) {
                  setStreamError(null);
                  if (fallback.kind === "quality") {
                    setSelectedQuality(fallback.quality);
                  } else {
                    setAuthorizedFallbackUrl(fallback.url);
                  }
                  showQuickToast(`Vidmoly unavailable — switched to authorized ${fallback.quality} stream`);
                  return;
                }
                setIsBuffering(false);
                setIsPlaying(false);
                setStreamError({
                  code: vmCode ? String(vmCode).toUpperCase() : "VIDMOLY_EMBED_ERROR",
                  message: vmMessage,
                });
              }}
            />
          ) : streamInfo.kind === "invalid" ? null : (
            <video
              key={`${activePlayingEpisode.id}::${streamInfo.url}`}
              ref={videoRef}
              src={streamInfo.kind === "direct" ? streamInfo.url : undefined}
              autoPlay
              playsInline
              preload="auto"
              onPlay={() => {
                setIsPlaying(true);
                if (videoRef.current) {
                  videoRef.current.playbackRate = playbackSpeed;
                }
              }}
              onPause={() => {
                setIsPlaying(false);
                setIsBuffering(false);
                if (videoRef.current) {
                  persistWatchProgress(
                    videoRef.current.currentTime,
                    videoRef.current.duration || duration || 0,
                    true
                  );
                }
              }}
              onTimeUpdate={handleTimeUpdate}
              onWaiting={() => setIsBuffering(true)}
              onStalled={() => setIsBuffering(true)}
              onCanPlayThrough={() => setIsBuffering(false)}
              onPlaying={() => {
                setIsBuffering(false);
                setStreamError(null);
                streamRetryCountRef.current = 0;
              }}
              onError={() => {
                const video = videoRef.current;
                const mediaErrCode = video?.error?.code;

                // Ignore spurious errors while HLS effect handles or before src is bound
                if (streamInfo.kind === "hls" && Hls.isSupported()) {
                  return;
                }

                // Auto-recover from transient network drops or fall back to an alternate quality source
                if (mediaErrCode === MediaError.MEDIA_ERR_NETWORK && streamRetryCountRef.current < 2 && video) {
                  streamRetryCountRef.current += 1;
                  pendingSeekRef.current = video.currentTime || 0;
                  shouldResumeAfterSwitchRef.current = true;
                  setTimeout(() => {
                    if (videoRef.current) {
                      videoRef.current.load();
                      videoRef.current.play().catch(() => {});
                    }
                  }, 1200);
                  return;
                }

                triedUrlsRef.current.add(activeStreamUrl);
                const fallbackSource = availableQualitySources.find(
                  (s) => s.url !== activeStreamUrl && !triedUrlsRef.current.has(s.url)
                );
                if (fallbackSource && streamRetryCountRef.current < 3) {
                  streamRetryCountRef.current += 1;
                  if (video) {
                    pendingSeekRef.current = video.currentTime || 0;
                    shouldResumeAfterSwitchRef.current = true;
                  }
                  setSelectedQuality(fallbackSource.quality);
                  showQuickToast(`Switched to ${fallbackSource.quality} for smooth streaming`);
                  return;
                }

                setIsBuffering(false);
                const mappedMediaCode =
                  mediaErrCode === MediaError.MEDIA_ERR_ABORTED
                    ? "MEDIA_ERR_ABORTED (1)"
                    : mediaErrCode === MediaError.MEDIA_ERR_NETWORK
                    ? "MEDIA_ERR_NETWORK (2)"
                    : mediaErrCode === MediaError.MEDIA_ERR_DECODE
                    ? "MEDIA_ERR_DECODE (3)"
                    : mediaErrCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
                    ? "MEDIA_ERR_SRC_NOT_SUPPORTED (4)"
                    : "MEDIA_ERR_UNKNOWN";
                setStreamError({
                  code: mappedMediaCode,
                  message: "Unable to load this video stream. Verify the stream URL or your connection.",
                });
                if (
                  mediaErrCode !== MediaError.MEDIA_ERR_DECODE &&
                  mediaErrCode !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
                ) {
                  window.dispatchEvent(new CustomEvent("yg:network-check"));
                }
              }}
              onLoadedMetadata={() => {
                const video = videoRef.current;
                if (!video) return;
                setDuration(video.duration);
                video.playbackRate = playbackSpeed;
                video.volume = volume;
                video.muted = isMuted;

                // Detect actual native video dimensions & resolution
                const vw = video.videoWidth || 0;
                const vh = video.videoHeight || 0;
                if (vw > 0 && vh > 0) {
                  setDetectedDimensions({ w: vw, h: vh });
                }
                if (vh >= 2160) setDetectedResolution("2160p");
                else if (vh >= 1440) setDetectedResolution("1440p");
                else if (vh >= 1080) setDetectedResolution("1080p");
                else if (vh >= 720) setDetectedResolution("720p");
                else if (vh >= 480) setDetectedResolution("480p");
                else if (vh > 0) setDetectedResolution(`${vh}p`);

                // Seamlessly restore saved watch timestamp OR quality-switch position
                if (pendingSeekRef.current !== null && !isNaN(pendingSeekRef.current)) {
                  const targetSec = Math.min(pendingSeekRef.current, video.duration || pendingSeekRef.current);
                  if (targetSec > 0) {
                    video.currentTime = targetSec;
                    setCurrentTime(targetSec);
                  }
                  pendingSeekRef.current = null;
                  if (shouldResumeAfterSwitchRef.current) {
                    video.play().catch(() => {});
                  }
                }
              }}
              onCanPlay={() => {
                setIsBuffering(false);
                const video = videoRef.current;
                if (!video) return;
                if (pendingSeekRef.current !== null && !isNaN(pendingSeekRef.current) && pendingSeekRef.current > 0) {
                  const targetSec = Math.min(pendingSeekRef.current, video.duration || pendingSeekRef.current);
                  video.currentTime = targetSec;
                  lastUiTimeUpdateRef.current = targetSec;
                  setCurrentTime(targetSec);
                  pendingSeekRef.current = null;
                  if (shouldResumeAfterSwitchRef.current) {
                    video.play().catch(() => {});
                  }
                }
              }}
              onResize={() => {
                const video = videoRef.current;
                if (!video) return;
                const vw = video.videoWidth || 0;
                const vh = video.videoHeight || 0;
                if (vw > 0 && vh > 0) {
                  setDetectedDimensions({ w: vw, h: vh });
                  if (vh >= 2160) setDetectedResolution("2160p");
                  else if (vh >= 1440) setDetectedResolution("1440p");
                  else if (vh >= 1080) setDetectedResolution("1080p");
                  else if (vh >= 720) setDetectedResolution("720p");
                  else if (vh >= 480) setDetectedResolution("480p");
                  else setDetectedResolution(`${vh}p`);
                }
              }}
              className="w-full h-full object-contain bg-black pointer-events-none"
            />
          )
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center text-white space-y-3">
            <AlertCircle className="w-10 h-10 text-amber-400" />
            <p className="text-sm font-bold">No Video Stream Attached</p>
            <p className="text-xs text-neutral-400 max-w-xs">
              Add a valid YouTube, M3U8, or MP4 stream URL for this episode in Admin Studio to start playback.
            </p>
          </div>
        )}

        {/* Stream Error Overlay */}
        {streamError && (
          <div
            data-interactive="true"
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-0 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center text-white space-y-3 z-30"
          >
            <AlertCircle className="w-10 h-10 text-rose-400" />
            <p className="text-sm font-bold">Stream Playback Error</p>
            <span className="px-2.5 py-0.5 rounded-md bg-rose-500/15 border border-rose-500/35 text-[11px] font-mono font-bold text-rose-300">
              Error Code: {streamError.code}
            </span>
            <p className="text-xs text-neutral-300 max-w-sm leading-relaxed">{streamError.message}</p>
            {streamInfo.kind === "invalid" ? (
              <button
                type="button"
                onClick={handleClosePlayback}
                className="theme-btn-primary px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Go Back</span>
              </button>
            ) : (
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setStreamError(null);
                    triedUrlsRef.current.clear();
                    if (streamInfo.kind === "youtube") {
                      ytPlayerRef.current?.reload();
                    } else if (streamInfo.kind === "vidmoly") {
                      vidmolyPlayerRef.current?.reload();
                    } else if (streamInfo.kind === "hls") {
                      setIsBuffering(true);
                      if (videoRef.current && videoRef.current.currentTime > 0) {
                        pendingSeekRef.current = videoRef.current.currentTime;
                      }
                      setHlsRetryNonce((n) => n + 1);
                    } else if (videoRef.current) {
                      videoRef.current.load();
                      videoRef.current.play().catch(() => {});
                    }
                  }}
                  className="theme-btn-primary min-h-[44px] px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry Stream</span>
                </button>
                {streamInfo.kind === "vidmoly" && (streamInfo.embedUrl || streamInfo.originalUrl) && (
                  <a
                    href={streamInfo.embedUrl || streamInfo.originalUrl || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 border border-white/15 text-xs font-bold text-white flex items-center gap-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Open Source Link</span>
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {/* Pure In-App Software Dimmer Overlay (MovieBox-inspired, zero device hardware APIs) */}
        {softwareDimOpacity > 0 && (
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-black pointer-events-none transition-opacity duration-75"
            style={{ opacity: softwareDimOpacity }}
          />
        )}
      </div>

      {/* Quick Speed / Quality / Audio Feedback HUD Toast */}
      {!isLocked && feedbackToast && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute top-16 sm:top-20 left-1/2 -translate-x-1/2 z-[60] max-w-[85vw] truncate px-3.5 py-1.5 rounded-full bg-black/80 backdrop-blur-md border border-white/15 text-[11px] sm:text-xs font-semibold text-white shadow-lg animate-in fade-in duration-150"
        >
          {feedbackToast}
        </div>
      )}

      {/* MovieBox-Inspired Left-Side App Brightness Floating HUD */}
      {showBrightnessHud && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute left-5 md:left-10 top-1/2 -translate-y-1/2 z-50 flex flex-col items-center gap-2.5 px-3.5 py-4 rounded-2xl bg-black/80 backdrop-blur-xl border border-amber-400/30 shadow-[0_8px_32px_rgba(0,0,0,0.65)] animate-in fade-in duration-150"
        >
          <Sun className="w-5 h-5 text-amber-400" />
          <div className="w-2 h-28 rounded-full bg-white/15 overflow-hidden flex flex-col justify-end">
            <div
              className="w-full rounded-full bg-gradient-to-t from-amber-500 to-yellow-300 transition-all duration-75"
              style={{ height: `${brightnessBarPercent}%` }}
            />
          </div>
          <span className="text-[11px] font-mono font-bold text-amber-300 tabular-nums">
            {brightness}%
          </span>
          <span className="text-[9px] uppercase tracking-wider text-white/60 font-semibold">
            App Light
          </span>
        </div>
      )}

      {/* Buffering Indicator */}
      {isBuffering && !streamError && activeStreamUrl && (
        <div
          role="status"
          aria-live="polite"
          aria-label="Buffering video stream"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 pointer-events-none z-20"
        >
          <div className="px-4 py-3 rounded-2xl bg-black/75 backdrop-blur-md border border-white/10 flex flex-col items-center gap-2 shadow-xl">
            <div className="w-11 h-11 rounded-full border-4 border-white/20 border-t-[var(--primary)] animate-spin" />
            <span className="text-xs font-bold text-white tracking-wide">Buffering...</span>
            {bufferingHint && (
              <span className="text-[10px] font-medium text-amber-300 text-center max-w-[220px]">
                {bufferingHint}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Double Tap Skip Left Indicator */}
      {skipRipple === "left" && (
        <div className="absolute left-12 top-1/2 -translate-y-1/2 flex flex-col items-center justify-center w-24 h-24 rounded-full bg-black/70 backdrop-blur-md text-white pointer-events-none animate-pulse z-40">
          <RotateCcw className="w-8 h-8 text-[var(--primary)]" />
          <span className="text-xs font-bold mt-1">-10s</span>
        </div>
      )}

      {/* Double Tap Skip Right Indicator */}
      {skipRipple === "right" && (
        <div className="absolute right-12 top-1/2 -translate-y-1/2 flex flex-col items-center justify-center w-24 h-24 rounded-full bg-black/70 backdrop-blur-md text-white pointer-events-none animate-pulse z-40">
          <RotateCw className="w-8 h-8 text-[var(--primary)]" />
          <span className="text-xs font-bold mt-1">+10s</span>
        </div>
      )}

      {/* Floating exit pill when YouTube Native Quality Controls are active */}
      {showNativeYtControls && streamInfo.kind === "youtube" && (
        <div
          data-interactive="true"
          onClick={(e) => e.stopPropagation()}
          className="absolute top-4 right-4 z-50 flex items-center gap-2"
        >
          <span className="hidden sm:inline px-3 py-1.5 rounded-xl bg-black/80 border border-white/15 text-[11px] text-neutral-200 backdrop-blur-md">
            Use the Gear icon at bottom-right to adjust YouTube Quality
          </span>
          <button
            type="button"
            onClick={() => {
              sound.playClick();
              setShowNativeYtControls(false);
              setShowControls(true);
              resetAutohideTimer();
            }}
            className="min-h-[44px] px-4 rounded-xl bg-[var(--primary)] text-white text-xs font-bold shadow-lg flex items-center gap-1.5 active:scale-95 transition-transform"
          >
            <Check className="w-4 h-4" />
            <span>Back to YG Controls</span>
          </button>
        </div>
      )}

      {/* Screen Lock Touch Shield & Single-Tap Compact Unlock Pill */}
      {isLocked && (
        <div
          data-locked-shield="true"
          onTouchStart={(e) => {
            if (e.touches.length === 1) {
              lockTouchStartRef.current = {
                x: e.touches[0].clientX,
                y: e.touches[0].clientY,
              };
            } else {
              lockTouchStartRef.current = null;
            }
          }}
          onTouchEnd={(e) => {
            const start = lockTouchStartRef.current;
            lockTouchStartRef.current = null;
            if (!start || e.changedTouches.length === 0) return;
            const dx = Math.abs(e.changedTouches[0].clientX - start.x);
            const dy = Math.abs(e.changedTouches[0].clientY - start.y);
            // Ignore accidental drag/pocket swipes
            if (dx > 12 || dy > 12) return;
            const target = e.target as HTMLElement;
            if (target.closest("[data-unlock-btn='true']")) return;
            e.preventDefault();
            e.stopPropagation();
            skipNextClickRef.current = true;
            setTimeout(() => {
              skipNextClickRef.current = false;
            }, 250);
            revealUnlockControl();
          }}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest("[data-unlock-btn='true']")) return;
            e.stopPropagation();
            revealUnlockControl();
          }}
          className="absolute inset-0 z-50 bg-transparent touch-manipulation"
        >
          {showUnlockButton && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 animate-in fade-in zoom-in-95 duration-200">
              <button
                type="button"
                data-unlock-btn="true"
                data-interactive="true"
                onClick={(e) => {
                  e.stopPropagation();
                  deactivateLockMode();
                }}
                aria-label="Unlock screen controls"
                className="min-h-[40px] px-3.5 py-1.5 rounded-full bg-black/80 hover:bg-black/90 backdrop-blur-md border border-white/25 text-white text-xs font-semibold flex items-center gap-1.5 shadow-xl active:scale-95 transition-all whitespace-nowrap"
              >
                <Unlock className="w-3.5 h-3.5 text-[var(--primary)] shrink-0" />
                <span>Unlock</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Screen Lock Toggle Button (shown only while controls are active and unlocked) */}
      {!isLocked && showControls && !showSettingsMenu && !showNativeYtControls && streamInfo.kind !== "vidmoly" && (
        <div className="absolute right-4 top-20 z-50 transition-opacity duration-200">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              activateLockMode();
            }}
            aria-label="Lock screen controls"
            title="Lock Screen Controls"
            className="min-h-[40px] min-w-[40px] rounded-full flex items-center justify-center bg-black/65 hover:bg-black/85 text-white/85 hover:text-white backdrop-blur-md border border-white/15 active:scale-95 transition-all"
          >
            <Lock className="w-4 h-4 sm:w-5 sm:h-5" />
          </button>
        </div>
      )}

      {/* Top Header Bar */}
      <div
        className={`absolute top-0 left-0 right-0 p-3 sm:p-4 bg-gradient-to-b from-black/90 via-black/55 to-transparent flex items-center justify-between gap-2 transition-opacity duration-200 z-40 ${
          isLocked
            ? "opacity-0 pointer-events-none"
            : streamInfo.kind === "vidmoly"
            ? "opacity-100 pointer-events-none"
            : showControls && !showNativeYtControls
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center gap-3 min-w-0 pointer-events-auto">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleClosePlayback();
            }}
            aria-label="Back to Anime Details"
            className="min-h-[44px] min-w-[44px] rounded-xl bg-black/50 hover:bg-white/10 border border-white/10 flex items-center justify-center text-white transition-all active:scale-95 shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="leading-tight min-w-0">
            <h3 className="text-sm md:text-base font-bold text-white truncate max-w-[160px] sm:max-w-xs md:max-w-md">
              {activePlayingAnime.title}
            </h3>
            <p className="text-xs text-neutral-300 truncate flex items-center gap-1.5">
              <span className="truncate">
                S{(liveEpisode || activePlayingEpisode).season || 1} · E{(liveEpisode || activePlayingEpisode).number}: {(liveEpisode || activePlayingEpisode).title}
              </span>
              {(liveEpisode || activePlayingEpisode).language && (
                <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] font-semibold text-white/90 shrink-0">
                  {(liveEpisode || activePlayingEpisode).language}
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Top Right: Quick Vidmoly utilities (Episodes, Rotate, Fullscreen, Settings) & Dismiss X */}
        <div className="flex items-center gap-1.5 sm:gap-2 pointer-events-auto shrink-0">
          {streamInfo.kind === "vidmoly" && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  sound.playClick();
                  setShowEpisodesDrawer(true);
                }}
                aria-label="Episodes List"
                className="min-h-[44px] px-2.5 rounded-xl bg-black/60 hover:bg-white/15 border border-white/10 text-xs font-semibold text-white flex items-center gap-1.5"
              >
                <Layers className="w-4 h-4" />
                <span className="hidden md:inline">Episodes</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleScreenOrientation();
                }}
                aria-label={effectiveOrientation === "vertical" ? "Rotate to Horizontal View" : "Rotate to Vertical View"}
                title={effectiveOrientation === "vertical" ? "Switch to Horizontal" : "Switch to Vertical"}
                className={`min-h-[40px] px-2.5 rounded-lg border text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all ${
                  orientationMode !== "auto"
                    ? "bg-[var(--primary)]/20 border-[var(--primary)]/50 text-white"
                    : "bg-black/60 hover:bg-white/15 border-white/15 text-white"
                }`}
              >
                <RotateCwSquare className="w-3.5 h-3.5 text-[var(--primary)] shrink-0" />
                <span className="hidden sm:inline">
                  {effectiveOrientation === "vertical" ? "Horizontal" : "Vertical"}
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFullscreen();
                }}
                aria-label={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
                className="min-h-[44px] min-w-[44px] rounded-xl bg-black/60 hover:bg-white/15 border border-white/10 flex items-center justify-center text-white"
              >
                {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </button>
              {(streamInfo.embedUrl || streamInfo.originalUrl) && (
                <a
                  href={streamInfo.embedUrl || streamInfo.originalUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.stopPropagation();
                    sound.playClick();
                  }}
                  aria-label="Open Source Link Externally"
                  title="Open Source Link in Browser"
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-black/60 hover:bg-white/15 border border-white/10 flex items-center justify-center text-white"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </>
          )}

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openPauseSettingsDashboard();
            }}
            className="min-h-[44px] flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-black/60 hover:bg-white/15 border border-white/10 text-xs font-semibold text-white transition-all"
          >
            <Sliders className="w-4 h-4 text-[var(--primary)]" />
            <span className="hidden sm:inline">{streamInfo.kind === "vidmoly" ? "Settings" : "Pause & Settings"}</span>
          </button>

          {streamInfo.kind !== "vidmoly" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowControls(false);
              }}
              aria-label="Hide controls"
              className="min-h-[44px] min-w-[44px] rounded-xl bg-black/50 hover:bg-white/10 border border-white/10 flex items-center justify-center text-white/80 hover:text-white transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Center Controls (Quick Play & Seek — disabled on cross-origin Vidmoly iframe so native player receives clicks) */}
      {!isLocked && showControls && !showSettingsMenu && !showNativeYtControls && streamInfo.kind !== "vidmoly" && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-between px-6 md:px-24 z-30">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              seekRelative(-10);
            }}
            aria-label="Rewind 10 seconds"
            className="pointer-events-auto w-14 h-14 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-md border border-white/10 flex items-center justify-center text-white active:scale-95 transition-all"
          >
            <RotateCcw className="w-6 h-6" />
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="pointer-events-auto w-18 h-18 rounded-full bg-[var(--primary)] text-white shadow-[var(--accent-glow)] flex items-center justify-center active:scale-95 transition-all"
          >
            {isPlaying ? (
              <Pause className="w-8 h-8 fill-current" />
            ) : (
              <Play className="w-8 h-8 fill-current translate-x-0.5" />
            )}
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              seekRelative(10);
            }}
            aria-label="Forward 10 seconds"
            className="pointer-events-auto w-14 h-14 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-md border border-white/10 flex items-center justify-center text-white active:scale-95 transition-all"
          >
            <RotateCw className="w-6 h-6" />
          </button>
        </div>
      )}

      {/* Bottom Controls Bar (hidden on cross-origin Vidmoly iframe so Vidmoly's native seek/quality/fullscreen bar stays unobstructed) */}
      {streamInfo.kind !== "vidmoly" && (
      <div
        className={`absolute bottom-0 left-0 right-0 p-4 md:p-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent transition-opacity duration-300 z-40 ${
          showControls && !isLocked && !showSettingsMenu && !showNativeYtControls
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Progress Bar & Seek Slider */}
        <div className="w-full flex items-center gap-3 mb-3">
          <span className="text-xs font-mono tabular-nums text-white/90">
            {formatTime(currentTime)}
          </span>
          <div className="relative flex-1 flex items-center">
            <input
              type="range"
              min="0"
              max={duration || 100}
              step="0.1"
              value={currentTime}
              onChange={handleSeek}
              className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer"
            />
          </div>
          <span className="text-xs font-mono tabular-nums text-white/60">
            {formatTime(duration)}
          </span>
        </div>

        {/* Bottom Action Buttons Bar */}
        <div className="flex items-center justify-between gap-3">
          {/* Left: Volume & Brightness */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                sound.playClick();
                const nextMuted = !isMuted;
                if (streamInfo.kind === "youtube") {
                  ytPlayerRef.current?.setMuted(nextMuted);
                } else if (videoRef.current) {
                  videoRef.current.muted = nextMuted;
                }
                setIsMuted(nextMuted);
              }}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center text-white/80 hover:text-white"
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-5 h-5 text-rose-500" />
              ) : (
                <Volume2 className="w-5 h-5" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setVolume(val);
                setIsMuted(val === 0);
                if (streamInfo.kind === "youtube") {
                  ytPlayerRef.current?.setVolume(val);
                  ytPlayerRef.current?.setMuted(val === 0);
                } else if (videoRef.current) {
                  videoRef.current.volume = val;
                  videoRef.current.muted = val === 0;
                }
              }}
              className="w-16 md:w-24 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer hidden sm:block"
            />

            {/* In-App Brightness Control (Accessible on Mobile & Desktop) */}
            <div className="relative flex items-center gap-1.5 pl-2 sm:pl-3 border-l border-white/10">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  sound.playClick();
                  setShowBrightnessPopover((prev) => !prev);
                  resetAutohideTimer();
                }}
                aria-label="Adjust App Brightness"
                title="In-App Video Brightness (or swipe vertically on left side)"
                className={`min-h-[38px] px-2.5 rounded-xl flex items-center gap-1.5 border text-xs font-semibold transition-all ${
                  showBrightnessPopover || brightness !== 100
                    ? "bg-amber-500/20 border-amber-400/40 text-amber-300"
                    : "bg-white/5 border-white/10 text-white/80 hover:text-white"
                }`}
              >
                <Sun className="w-4 h-4 text-amber-400" />
                <span className="font-mono text-[11px]">{brightness}%</span>
              </button>

              <input
                type="range"
                min="15"
                max="160"
                value={brightness}
                onChange={(e) => updateInAppBrightness(parseInt(e.target.value, 10))}
                title="In-App Video Brightness"
                className="w-20 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer hidden md:block accent-amber-400"
              />

              {/* Mobile / Quick Popover Slider */}
              {showBrightnessPopover && (
                <div
                  data-interactive="true"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-12 left-0 z-50 w-56 p-3.5 rounded-2xl bg-neutral-950/95 backdrop-blur-xl border border-amber-400/25 shadow-2xl space-y-2.5"
                >
                  <div className="flex items-center justify-between text-[11px] font-bold">
                    <span className="flex items-center gap-1.5 text-amber-300">
                      <Sun className="w-3.5 h-3.5" />
                      <span>App Brightness</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => updateInAppBrightness(100)}
                      className="text-[10px] px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 text-white/80"
                    >
                      Reset 100%
                    </button>
                  </div>
                  <input
                    type="range"
                    min="15"
                    max="160"
                    value={brightness}
                    onChange={(e) => updateInAppBrightness(parseInt(e.target.value, 10))}
                    className="w-full h-2 bg-white/20 rounded-lg appearance-none cursor-pointer accent-amber-400"
                  />
                  <p className="text-[10px] text-neutral-400">
                    Tip: Swipe up/down on the left side anytime.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Right: Speed Quick Pill, Settings Dashboard Trigger, Episodes Drawer, Fullscreen */}
          <div className="flex items-center gap-1.5 md:gap-2.5">
            {/* Quick Speed Selector Pill (0.5x – 3x) */}
            <div className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  sound.playClick();
                  setShowBrightnessPopover(false);
                  setShowSpeedPopover((prev) => !prev);
                  resetAutohideTimer();
                }}
                aria-label="Playback Speed"
                className={`min-h-[38px] px-2.5 rounded-lg border text-xs font-mono font-bold flex items-center gap-1 transition-all ${
                  playbackSpeed !== 1 || showSpeedPopover
                    ? "bg-[var(--primary)]/25 border-[var(--primary)]/50 text-white"
                    : "bg-white/10 hover:bg-white/20 border-white/10 text-white"
                }`}
              >
                <Gauge className="w-3.5 h-3.5 text-[var(--primary)]" />
                <span>{playbackSpeed}x</span>
              </button>

              {showSpeedPopover && (
                <div
                  data-interactive="true"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-12 right-0 z-50 w-56 p-3 rounded-2xl bg-neutral-950/95 backdrop-blur-xl border border-white/15 shadow-2xl space-y-2"
                >
                  <div className="flex items-center justify-between text-[11px] font-bold text-neutral-300">
                    <span>Playback Speed</span>
                    <span className="text-[var(--primary)] font-mono">{playbackSpeed}x</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3].map((spd) => (
                      <button
                        key={spd}
                        type="button"
                        onClick={() => {
                          handleSpeedChange(spd);
                          setShowSpeedPopover(false);
                        }}
                        className={`py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                          playbackSpeed === spd
                            ? "bg-[var(--primary)] text-white shadow-sm"
                            : "bg-white/5 hover:bg-white/15 text-neutral-300"
                        }`}
                      >
                        {spd}x
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openPauseSettingsDashboard();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--primary)]/20 hover:bg-[var(--primary)]/30 border border-[var(--primary)]/30 text-xs font-bold text-white transition-colors"
            >
              <Settings className="w-4 h-4 text-[var(--primary)]" />
              <span className="hidden sm:inline">Settings</span>
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowEpisodesDrawer(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold text-white transition-colors"
            >
              <Layers className="w-4 h-4" />
              <span className="hidden sm:inline">Episodes</span>
            </button>

            {/* Rotate Orientation Button (Compact Vertical / Horizontal Toggle) */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleScreenOrientation();
              }}
              aria-label={
                effectiveOrientation === "vertical"
                  ? "Rotate to Horizontal View"
                  : "Rotate to Vertical View"
              }
              title={
                effectiveOrientation === "vertical"
                  ? "See in Horizontal View"
                  : "See in Vertical View"
              }
              className={`min-h-[40px] px-2.5 rounded-lg border text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all ${
                orientationMode !== "auto"
                  ? "bg-[var(--primary)]/25 border-[var(--primary)]/50 text-white"
                  : "bg-white/10 hover:bg-white/20 border-white/10 text-white"
              }`}
            >
              <RotateCwSquare className="w-3.5 h-3.5 text-[var(--primary)] shrink-0" />
              <span className="hidden sm:inline">
                {effectiveOrientation === "vertical" ? "Horizontal" : "Vertical"}
              </span>
            </button>

            {/* Fullscreen Button */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleFullscreen();
              }}
              aria-label={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center text-white/80 hover:text-white"
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>
      )}

      {/* ======================================================= */}
      {/* 2-CLICKS PAUSE & SETTINGS DASHBOARD (FULL OVERLAY PANEL) */}
      {/* ======================================================= */}
      {showSettingsMenu && (
        <div
          data-interactive="true"
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-200"
        >
          <div className="w-full max-w-md max-h-[90%] overflow-y-auto bg-neutral-900 border border-white/15 rounded-3xl p-5 sm:p-6 shadow-2xl text-white space-y-5">
            {/* Dashboard Header */}
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[var(--primary)]/20 border border-[var(--primary)]/30 flex items-center justify-center text-[var(--primary)]">
                  <Sliders className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Pause & Settings Dashboard</h3>
                  <p className="text-[11px] text-neutral-400 truncate max-w-[200px]">
                    Ep {activePlayingEpisode.number}: {activePlayingEpisode.title}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={resumeFromDashboard}
                className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-neutral-300 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Center Quick Play / Rewind / Forward Controls (N/A for cross-origin Vidmoly iframe) */}
            {streamInfo.kind !== "vidmoly" && (
              <div className="p-4 rounded-2xl bg-black/50 border border-white/10 flex items-center justify-around">
                <button
                  type="button"
                  onClick={() => seekRelative(-10)}
                  className="flex flex-col items-center gap-1 text-neutral-300 hover:text-white active:scale-95 transition-transform"
                >
                  <RotateCcw className="w-6 h-6 text-[var(--primary)]" />
                  <span className="text-[10px] font-bold">-10s</span>
                </button>

                <button
                  type="button"
                  onClick={resumeFromDashboard}
                  className="w-16 h-16 rounded-full bg-[var(--primary)] text-white shadow-[var(--accent-glow)] flex items-center justify-center active:scale-95 transition-transform"
                >
                  <Play className="w-7 h-7 fill-current translate-x-0.5" />
                </button>

                <button
                  type="button"
                  onClick={() => seekRelative(10)}
                  className="flex flex-col items-center gap-1 text-neutral-300 hover:text-white active:scale-95 transition-transform"
                >
                  <RotateCw className="w-6 h-6 text-[var(--primary)]" />
                  <span className="text-[10px] font-bold">+10s</span>
                </button>
              </div>
            )}

            {/* Playback Speed Selector (0.5x up to 3x) */}
            {streamInfo.kind !== "vidmoly" && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-semibold text-neutral-300">
                  <span>Playback Speed</span>
                  <span className="text-[var(--primary)] font-mono">{playbackSpeed}x</span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3].map((spd) => (
                    <button
                      key={spd}
                      type="button"
                      onClick={() => handleSpeedChange(spd)}
                      className={`py-1.5 rounded-xl text-xs font-bold transition-all ${
                        playbackSpeed === spd
                          ? "bg-[var(--primary)] text-white shadow-sm"
                          : "bg-white/5 hover:bg-white/10 text-neutral-300"
                      }`}
                    >
                      {spd}x
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Real Streaming Quality Selector */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-neutral-300">
                <span>Streaming Quality</span>
                <span className="text-[var(--primary)] font-mono">
                  {streamInfo.kind === "youtube"
                    ? "YouTube Adaptive (Native Player)"
                    : streamInfo.kind === "vidmoly"
                    ? "Vidmoly Embed Player"
                    : streamInfo.kind === "hls" && hlsLevels.length > 1
                    ? selectedHlsLevel === -1
                      ? `Auto · ABR${
                          hlsLevels.find((l) => l.index === activeHlsLevel)?.label
                            ? ` (${hlsLevels.find((l) => l.index === activeHlsLevel)!.label})`
                            : detectedResolution
                            ? ` (${detectedResolution})`
                            : ""
                        }`
                      : `Manual · ${hlsLevels.find((l) => l.index === selectedHlsLevel)?.label || "Selected"}`
                    : streamInfo.kind === "hls" && hlsLevels.length === 1
                    ? `HLS · ${hlsLevels[0].label}`
                    : streamInfo.kind === "hls"
                    ? detectedResolution
                      ? `HLS Native (${detectedResolution})`
                      : "HLS Adaptive"
                    : availableQualitySources.length > 1
                    ? selectedQuality === "Auto"
                      ? `Auto (${resolvedStream.effectiveQuality})`
                      : `Manual · ${getQualityDisplayLabel(selectedQuality)}`
                    : detectedResolution
                    ? `Source (${detectedResolution})`
                    : "Original Source"}
                </span>
              </div>

              {streamInfo.kind === "youtube" ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-neutral-400 bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                    Resolution scaling is handled directly by the official YouTube IFrame Player. Use YouTube&apos;s Settings gear menu to pick quality.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      sound.playClick();
                      setShowSettingsMenu(false);
                      setShowControls(false);
                      setShowNativeYtControls(true);
                    }}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-bold text-white flex items-center justify-center gap-2 transition-colors"
                  >
                    <Settings className="w-4 h-4 text-[var(--primary)]" />
                    <span>Open YouTube Native Quality Controls</span>
                  </button>
                </div>
              ) : streamInfo.kind === "vidmoly" ? (
                <div className="space-y-2">
                  <div className="text-[11px] text-neutral-300 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                    Quality, captions, and audio controls are managed natively inside the embedded Vidmoly player ({streamInfo.vidmolyId}).
                  </div>
                  {availableQualitySources.length > 1 && (
                    <div className="flex flex-wrap gap-1.5">
                      {availableQualitySources.map((src) => (
                        <button
                          key={src.quality}
                          type="button"
                          onClick={() => handleQualityChange(src.quality)}
                          className={`min-h-[44px] flex-1 min-w-[76px] py-2 px-2.5 rounded-xl text-xs font-bold transition-all ${
                            selectedQuality.toLowerCase() === src.quality.toLowerCase()
                              ? "bg-[var(--primary)] text-white shadow-sm"
                              : "bg-white/5 hover:bg-white/10 text-neutral-300"
                          }`}
                        >
                          {src.displayLabel}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : streamInfo.kind === "hls" && hlsLevels.length > 1 ? (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleHlsLevelChange(-1)}
                      className={`min-h-[44px] flex-1 min-w-[96px] py-2 px-2.5 rounded-xl text-xs font-bold transition-all ${
                        selectedHlsLevel === -1
                          ? "bg-[var(--primary)] text-white shadow-sm"
                          : "bg-white/5 hover:bg-white/10 text-neutral-300"
                      }`}
                    >
                      Auto (ABR)
                    </button>
                    {hlsLevels.map((lvl) => {
                      const mbpsText =
                        lvl.bitrateKbps >= 1000
                          ? `${(lvl.bitrateKbps / 1000).toFixed(1)} Mbps`
                          : lvl.bitrateKbps > 0
                          ? `${lvl.bitrateKbps} kbps`
                          : "";
                      return (
                        <button
                          key={`${lvl.index}-${lvl.label}`}
                          type="button"
                          onClick={() => handleHlsLevelChange(lvl.index)}
                          className={`min-h-[44px] flex-1 min-w-[82px] py-1.5 px-2.5 rounded-xl text-xs font-bold transition-all flex flex-col items-center justify-center leading-tight ${
                            selectedHlsLevel === lvl.index
                              ? "bg-[var(--primary)] text-white shadow-sm"
                              : "bg-white/5 hover:bg-white/10 text-neutral-300"
                          }`}
                        >
                          <span>{lvl.label}</span>
                          {mbpsText && (
                            <span
                              className={`text-[9px] font-medium mt-0.5 ${
                                selectedHlsLevel === lvl.index ? "text-white/80" : "text-neutral-400"
                              }`}
                            >
                              {mbpsText}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-neutral-400">
                    {selectedHlsLevel === -1
                      ? "Auto switches dynamically across genuine HLS renditions based on bandwidth."
                      : `Locked to ${hlsLevels.find((l) => l.index === selectedHlsLevel)?.label || "selected"} (${hlsLevels.find((l) => l.index === selectedHlsLevel)?.width || "?"}×${hlsLevels.find((l) => l.index === selectedHlsLevel)?.height || "?"}).`}
                  </p>
                </div>
              ) : streamInfo.kind === "hls" ? (
                <div className="text-[11px] text-neutral-300 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                  {hlsLevels.length === 1
                    ? `HLS Single Rendition · ${hlsLevels[0].width && hlsLevels[0].height ? `${hlsLevels[0].width}×${hlsLevels[0].height} (${hlsLevels[0].label})` : hlsLevels[0].label}.`
                    : detectedDimensions
                    ? `HLS Adaptive Stream · Current resolution: ${detectedDimensions.w}×${detectedDimensions.h} (${detectedResolution}).`
                    : detectedResolution
                    ? `HLS Adaptive Stream · Current resolution: ${detectedResolution}.`
                    : "HLS Adaptive Stream · Parsing playlist manifest..."}
                </div>
              ) : availableQualitySources.length > 1 ? (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleQualityChange("Auto")}
                      className={`min-h-[44px] flex-1 min-w-[82px] py-2 px-2.5 rounded-xl text-xs font-bold transition-all ${
                        selectedQuality === "Auto"
                          ? "bg-[var(--primary)] text-white shadow-sm"
                          : "bg-white/5 hover:bg-white/10 text-neutral-300"
                      }`}
                    >
                      Auto
                    </button>
                    {availableQualitySources.map((src) => (
                      <button
                        key={src.quality}
                        type="button"
                        onClick={() => handleQualityChange(src.quality)}
                        className={`min-h-[44px] flex-1 min-w-[76px] py-2 px-2.5 rounded-xl text-xs font-bold transition-all ${
                          selectedQuality.toLowerCase() === src.quality.toLowerCase()
                            ? "bg-[var(--primary)] text-white shadow-sm"
                            : "bg-white/5 hover:bg-white/10 text-neutral-300"
                        }`}
                      >
                        {src.displayLabel}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="text-[11px] text-neutral-300 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                    {detectedDimensions
                      ? `Single stream source · Actual resolution: ${detectedDimensions.w}×${detectedDimensions.h} (${detectedResolution}).`
                      : detectedResolution
                      ? `Single stream source · Resolution: ${detectedResolution}.`
                      : "Single stream source · Reading video stream metadata..."}
                  </div>
                </div>
              )}
            </div>

            {/* Embedded HLS Multi-Audio Track Switcher (when Bunny Stream / HLS manifest includes multiple audio tracks) */}
            {streamInfo.kind === "hls" && hlsAudioTracks.length > 1 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-semibold text-neutral-300">
                  <span className="flex items-center gap-1.5">
                    <Languages className="w-3.5 h-3.5 text-[var(--primary)]" />
                    <span>HLS Audio Track</span>
                  </span>
                  <span className="text-[var(--primary)] font-mono">
                    {hlsAudioTracks.find((t) => t.index === selectedHlsAudioTrack)?.name || "Default"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {hlsAudioTracks.map((track) => (
                    <button
                      key={`${track.index}-${track.name}`}
                      type="button"
                      onClick={() => handleHlsAudioTrackChange(track.index)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                        selectedHlsAudioTrack === track.index
                          ? "bg-[var(--primary)] text-white shadow-sm"
                          : "bg-white/5 hover:bg-white/10 text-neutral-300"
                      }`}
                    >
                      {track.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Episode Database Language Version Switcher */}
            {siblingLanguageVersions.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-semibold text-neutral-300">
                  <span className="flex items-center gap-1.5">
                    <Languages className="w-3.5 h-3.5 text-[var(--primary)]" />
                    <span>Episode Release Language</span>
                  </span>
                  <span className="text-[var(--primary)] font-mono">
                    {activePlayingEpisode.language || "Japanese"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {siblingLanguageVersions.map((ver) => (
                    <button
                      key={ver.id}
                      type="button"
                      onClick={() => handleLanguageSwitch(ver)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                        ver.id === activePlayingEpisode.id
                          ? "bg-[var(--primary)] text-white shadow-sm"
                          : "bg-white/5 hover:bg-white/10 text-neutral-300"
                      }`}
                    >
                      {ver.language || "Japanese"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Screen View Mode (Compact Vertical / Horizontal Segmented Controls) */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs font-semibold text-neutral-300 whitespace-nowrap">
                  Screen View
                </span>
                <span className="text-[11px] text-[var(--primary)] font-mono capitalize whitespace-nowrap">
                  · {effectiveOrientation}
                </span>
              </div>
              <div
                role="group"
                aria-label="Screen orientation"
                className="inline-flex items-center gap-1 p-1 rounded-xl bg-white/5 border border-white/10 shrink-0"
              >
                <button
                  type="button"
                  aria-pressed={effectiveOrientation === "vertical"}
                  onClick={() => toggleScreenOrientation("vertical")}
                  className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all active:scale-95 ${
                    effectiveOrientation === "vertical"
                      ? "bg-[var(--primary)] text-white shadow-sm ring-1 ring-white/20"
                      : "text-neutral-300 hover:text-white hover:bg-white/10"
                  }`}
                >
                  <RectangleVertical className="w-3.5 h-3.5 shrink-0" />
                  <span>Vertical</span>
                </button>
                <button
                  type="button"
                  aria-pressed={effectiveOrientation === "horizontal"}
                  onClick={() => toggleScreenOrientation("horizontal")}
                  className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all active:scale-95 ${
                    effectiveOrientation === "horizontal"
                      ? "bg-[var(--primary)] text-white shadow-sm ring-1 ring-white/20"
                      : "text-neutral-300 hover:text-white hover:bg-white/10"
                  }`}
                >
                  <RectangleHorizontal className="w-3.5 h-3.5 shrink-0" />
                  <span>Horizontal</span>
                </button>
              </div>
            </div>

            {/* Brightness & Volume Sliders in Dashboard */}
            <div className={`grid ${streamInfo.kind === "vidmoly" ? "grid-cols-1" : "grid-cols-2"} gap-3 pt-1`}>
              <div className="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-semibold text-neutral-300">
                  <span className="flex items-center gap-1.5">
                    <Sun className="w-3.5 h-3.5 text-amber-400" />
                    <span>App Brightness</span>
                  </span>
                  <span className="font-mono text-amber-400">{brightness}%</span>
                </div>
                <input
                  type="range"
                  min="15"
                  max="160"
                  value={brightness}
                  onChange={(e) => updateInAppBrightness(parseInt(e.target.value, 10))}
                  className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-amber-400"
                />
              </div>

              {streamInfo.kind !== "vidmoly" && (
                <div className="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                  <div className="flex items-center justify-between text-[11px] font-semibold text-neutral-300">
                    <span className="flex items-center gap-1.5">
                      <Volume2 className="w-3.5 h-3.5 text-sky-400" />
                      <span>Volume</span>
                    </span>
                    <span className="font-mono text-sky-400">{Math.round(volume * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={isMuted ? 0 : volume}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      setVolume(val);
                      setIsMuted(val === 0);
                      if (streamInfo.kind === "youtube") {
                        ytPlayerRef.current?.setVolume(val);
                        ytPlayerRef.current?.setMuted(val === 0);
                      } else if (videoRef.current) {
                        videoRef.current.volume = val;
                        videoRef.current.muted = val === 0;
                      }
                    }}
                    className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer"
                  />
                </div>
              )}
            </div>

            {/* Bottom Actions */}
            <div className="pt-2 flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setShowSettingsMenu(false);
                  setShowEpisodesDrawer(true);
                  sound.playClick();
                }}
                className="flex-1 h-11 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold text-white flex items-center justify-center gap-1.5 transition-colors"
              >
                <Layers className="w-4 h-4" />
                <span>Episodes List</span>
              </button>

              <button
                type="button"
                onClick={resumeFromDashboard}
                className="theme-btn-primary flex-1 h-11 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95 transition-transform"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Resume Playback</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Episode Switcher Drawer */}
      {showEpisodesDrawer && (
        <div
          data-interactive="true"
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-y-0 right-0 z-50 w-80 md:w-96 bg-neutral-950/95 border-l border-white/10 p-6 flex flex-col backdrop-blur-2xl text-white"
        >
          <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-4">
            <div>
              <h4 className="font-bold text-sm">Episodes</h4>
              <p className="text-xs text-neutral-400">{activePlayingAnime.title}</p>
            </div>
            <button
              type="button"
              onClick={() => setShowEpisodesDrawer(false)}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center text-neutral-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {(() => {
              const drawerEpisodes =
                fetchedEpisodes.length > 0
                  ? fetchedEpisodes
                  : activePlayingEpisode
                  ? [activePlayingEpisode]
                  : [];

              if (drawerEpisodes.length === 0) {
                return (
                  <p className="text-xs text-neutral-400 text-center p-4 bg-white/5 rounded-xl">
                    No episodes available yet.
                  </p>
                );
              }

              return drawerEpisodes.map((epItem) => {
                const isCurrent = activePlayingEpisode.id === epItem.id;
                return (
                  <button
                    key={epItem.id}
                    type="button"
                    onClick={() => {
                      if (isCurrent) {
                        setShowEpisodesDrawer(false);
                        return;
                      }
                      flushCurrentProgress();
                      preserveLivePositionRef.current = null;
                      startPlayback(activePlayingAnime, epItem);
                      setShowEpisodesDrawer(false);
                    }}
                    className={`w-full p-3 rounded-xl flex items-center justify-between text-left transition-all ${
                      isCurrent
                        ? "bg-[var(--primary)] text-white font-bold shadow-md"
                        : "bg-white/5 hover:bg-white/10 text-neutral-300"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="px-2 h-7 rounded-lg bg-black/40 flex items-center justify-center text-[10px] font-mono shrink-0">
                        S{epItem.season || 1}·E{epItem.number}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs truncate">{epItem.title || `Episode ${epItem.number}`}</p>
                        {epItem.language && (
                          <p className={`text-[10px] truncate ${isCurrent ? "text-white/80" : "text-neutral-400"}`}>
                            {epItem.language}
                          </p>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 opacity-70 shrink-0" />
                  </button>
                );
              });
            })()}
          </div>
        </div>
      )}
      </div>
    </div>
  );
};
