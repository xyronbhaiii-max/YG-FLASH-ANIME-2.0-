import React, { useState, useEffect, useRef } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  Edit,
  Eye,
  EyeOff,
  Upload,
  Search,
  Sparkles,
  Layers,
  Check,
  AlertTriangle,
  RefreshCw,
  LogOut,
  Tv,
  Film,
  X,
  Play,
  ListPlus,
  ShieldCheck,
  ArrowUpDown,
  Users,
  BarChart3,
  Building2,
  TrendingUp,
  Calendar,
} from "lucide-react";
import {
  useApp,
  Anime,
  AnimeCastMember,
  Episode,
  EPISODE_LANGUAGES,
} from "../context/AppContext";
import {
  AUTHORIZED_ADMIN_EMAIL,
  getValidAdminIdToken,
  uploadVideoWithChunkFallback,
  refreshAdminUploadToken,
  UploadCancelHandle,
  UploadProgressInfo,
} from "../lib/firebase";
import {
  saveAnimeToFirebase,
  deleteAnimeFromFirebase,
  saveEpisodeToFirebase,
  saveBulkEpisodesToFirebase,
  reorderEpisodesInFirebase,
  deleteEpisodeFromFirebase,
  subscribeToAnimeEpisodes,
  fetchAnimeEpisodesOnce,
  sortEpisodes,
  mergeEpisodeLists,
  syncAnimePublishToEpisodesInFirebase,
  syncLocalCatalogAndEpisodesToFirebase,
} from "../lib/firebaseCatalog";
import { classifyStreamUrl, getStreamMimeType } from "../utils/streamUrl";
import {
  AGE_RATING_PRESETS,
  formatAgeRatingLabel,
  isValidAgeRating,
} from "../utils/ageRating";
import {
  VIDEO_QUALITIES,
  VIDEO_QUALITY_META,
  VideoQualityCode,
  normalizeQualityCode,
} from "../utils/videoQuality";
import { apiUrl } from "../utils/apiUrl";
import { sound } from "../utils/sound";

function createEmptyQualityMap(): Record<VideoQualityCode, string> {
  return {
    "2160p": "",
    "1440p": "",
    "1080p": "",
    "720p": "",
    "480p": "",
    "360p": "",
  };
}

function isPresetRating(val?: string | null): boolean {
  return (AGE_RATING_PRESETS as readonly string[]).includes(String(val || "").trim());
}

function isPresetLanguage(val?: string | null): boolean {
  return (EPISODE_LANGUAGES as readonly string[]).includes(String(val || "").trim());
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export const AdminDashboardView: React.FC = () => {
  const {
    isAdmin,
    isFirebaseAdminAuthenticated,
    logoutAdmin,
    goBack,
    refreshCatalog,
    catalog,
    navigateTo,
    startPlayback,
  } = useApp();

  const [allAnime, setAllAnime] = useState<Anime[]>([]);
  const [adminTab, setAdminTab] = useState<"catalog" | "insights">("catalog");
  const [adminStats, setAdminStats] = useState<any | null>(null);
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [isLoadingInsights, setIsLoadingInsights] = useState<boolean>(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSyncingCloud, setIsSyncingCloud] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError?: boolean } | null>(null);

  // Modals state
  const [showAddEditModal, setShowAddEditModal] = useState<boolean>(false);
  const [editingAnime, setEditingAnime] = useState<Anime | null>(null);
  const [animeToDelete, setAnimeToDelete] = useState<Anime | null>(null);

  // Episode Manager Modal
  const [managingAnimeEpisodes, setManagingAnimeEpisodes] = useState<Anime | null>(null);
  const [episodesList, setEpisodesList] = useState<Episode[]>([]);
  const [epManagerMode, setEpManagerMode] = useState<"single" | "bulk">("single");
  const [editingEpisodeId, setEditingEpisodeId] = useState<string | null>(null);
  const [newEpSeasonInput, setNewEpSeasonInput] = useState<string>("1");
  const [newEpNumberInput, setNewEpNumberInput] = useState<string>("1");
  const [newEpTitle, setNewEpTitle] = useState<string>("");
  const [newEpLanguagePreset, setNewEpLanguagePreset] = useState<string>("Japanese");
  const [newEpCustomLanguage, setNewEpCustomLanguage] = useState<string>("");
  const [newEpReleaseDate, setNewEpReleaseDate] = useState<string>("");
  const [newEpBunnyVideoId, setNewEpBunnyVideoId] = useState<string>("");
  const [newEpThumbnailUrl, setNewEpThumbnailUrl] = useState<string>("");
  const [newEpDescription, setNewEpDescription] = useState<string>("");
  const [epQualityUrls, setEpQualityUrls] = useState<Record<VideoQualityCode, string>>(
    createEmptyQualityMap
  );
  const [hlsInspectState, setHlsInspectState] = useState<{
    loading: boolean;
    error?: string;
    variants?: { height: number; width: number; bitrateKbps: number; resolution: string; label: string }[];
  } | null>(null);
  const [showAllEpQualities, setShowAllEpQualities] = useState<boolean>(false);
  const [isSavingEpisode, setIsSavingEpisode] = useState<boolean>(false);
  const [isUploadingEpThumb, setIsUploadingEpThumb] = useState<boolean>(false);
  const [isUploadingVideo, setIsUploadingVideo] = useState<boolean>(false);
  const [epUploadQualityTarget, setEpUploadQualityTarget] = useState<VideoQualityCode | null>(null);
  const [epVideoProgress, setEpVideoProgress] = useState<UploadProgressInfo | null>(null);
  const [epVideoFileName, setEpVideoFileName] = useState<string>("");
  const [epModalFeedback, setEpModalFeedback] = useState<{ text: string; isError?: boolean } | null>(null);
  const [epVideoFeedback, setEpVideoFeedback] = useState<{ text: string; isError?: boolean } | null>(null);
  const epUploadTaskRef = useRef<UploadCancelHandle | null>(null);
  const epFormRef = useRef<HTMLFormElement | null>(null);

  // Episode Search, Filters & Sort
  const [epSearchQuery, setEpSearchQuery] = useState<string>("");
  const [epSeasonFilter, setEpSeasonFilter] = useState<number | "ALL">("ALL");
  const [epLanguageFilter, setEpLanguageFilter] = useState<string>("ALL");
  const [epSortBy, setEpSortBy] = useState<
    "order" | "number-asc" | "number-desc" | "season-asc" | "updated-desc"
  >("order");

  // Bulk Add Episodes state (1..100+)
  const [bulkSeasonInput, setBulkSeasonInput] = useState<string>("1");
  const [bulkLanguagePreset, setBulkLanguagePreset] = useState<string>("Japanese");
  const [bulkCustomLanguage, setBulkCustomLanguage] = useState<string>("");
  const [bulkStartEpInput, setBulkStartEpInput] = useState<string>("1");
  const [bulkEndEpInput, setBulkEndEpInput] = useState<string>("5");
  const [bulkTitlePattern, setBulkTitlePattern] = useState<string>("Episode {n}");
  const [bulkSharedThumb, setBulkSharedThumb] = useState<string>("");
  const [bulkSharedDesc, setBulkSharedDesc] = useState<string>("");
  const [bulkAllowSharedUrl, setBulkAllowSharedUrl] = useState<boolean>(false);
  const [bulkSharedSingleUrl, setBulkSharedSingleUrl] = useState<string>("");
  const [bulkPasteUrls, setBulkPasteUrls] = useState<string>("");
  const [bulkRows, setBulkRows] = useState<
    { key: string; number: number; title: string; videoUrl: string; thumbnailUrl: string; description: string }[]
  >([]);
  const [isSavingBulk, setIsSavingBulk] = useState<boolean>(false);

  // AniList Search inside Add/Edit Modal
  const [aniListQuery, setAniListQuery] = useState<string>("");
  const [aniListResults, setAniListResults] = useState<any[]>([]);
  const [isSearchingAniList, setIsSearchingAniList] = useState<boolean>(false);

  // Anime Form Fields (mobile-safe numeric string inputs + confirmed age rating + all 6 qualities + credits/cast)
  const [formTitle, setFormTitle] = useState<string>("");
  const [formJapanese, setFormJapanese] = useState<string>("");
  const [formSynopsis, setFormSynopsis] = useState<string>("");
  const [formPoster, setFormPoster] = useState<string>("");
  const [formBanner, setFormBanner] = useState<string>("");
  const [formGenres, setFormGenres] = useState<string>("Action, Sci-Fi");
  const [formRatingSelect, setFormRatingSelect] = useState<string>("");
  const [formCustomRating, setFormCustomRating] = useState<string>("");
  const [formRatingConfirmed, setFormRatingConfirmed] = useState<boolean>(false);
  const [formStatus, setFormStatus] = useState<"Ongoing" | "Completed">("Ongoing");
  const [formYearInput, setFormYearInput] = useState<string>(String(new Date().getFullYear()));
  const [formSeasonsInput, setFormSeasonsInput] = useState<string>("1");
  const [formEpisodesInput, setFormEpisodesInput] = useState<string>("0");
  const [formIsPublished, setFormIsPublished] = useState<boolean>(true);
  const [formTrending, setFormTrending] = useState<boolean>(false);
  const [formStudio, setFormStudio] = useState<string>("");
  const [formAuthor, setFormAuthor] = useState<string>("");
  const [formDirector, setFormDirector] = useState<string>("");
  const [formProductionCompany, setFormProductionCompany] = useState<string>("");
  const [formCast, setFormCast] = useState<AnimeCastMember[]>([]);
  const [isFetchingCredits, setIsFetchingCredits] = useState<boolean>(false);
  const [formQualityUrls, setFormQualityUrls] = useState<Record<VideoQualityCode, string>>(
    createEmptyQualityMap
  );
  const [showAllAnimeQualities, setShowAllAnimeQualities] = useState<boolean>(false);
  const [isUploadingFile, setIsUploadingFile] = useState<boolean>(false);
  const [uploadingTarget, setUploadingTarget] = useState<"poster" | "banner" | null>(null);
  const [isUploadingAnimeVideo, setIsUploadingAnimeVideo] = useState<boolean>(false);
  const [animeUploadQualityTarget, setAnimeUploadQualityTarget] = useState<VideoQualityCode | null>(null);
  const [animeVideoProgress, setAnimeVideoProgress] = useState<UploadProgressInfo | null>(null);
  const [animeVideoFileName, setAnimeVideoFileName] = useState<string>("");
  const animeVideoTaskRef = useRef<UploadCancelHandle | null>(null);
  const [modalFeedback, setModalFeedback] = useState<{ text: string; isError?: boolean } | null>(null);
  const [animeVideoFeedback, setAnimeVideoFeedback] = useState<{ text: string; isError?: boolean } | null>(null);

  const catalogRef = useRef<Anime[]>(catalog);
  catalogRef.current = catalog;
  const hasLoadedAdminRef = useRef<boolean>(false);

  const getActiveToken = async (forceRefresh = false): Promise<string> => {
    const token = await getValidAdminIdToken(forceRefresh);
    if (token) return token;
    if (!forceRefresh) {
      return await getValidAdminIdToken(true);
    }
    return "";
  };

  const buildAdminHeaders = (
    token: string,
    extra: Record<string, string> = {}
  ): Record<string, string> => {
    const headers: Record<string, string> = { ...extra };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  };

  const adminFetch = async (
    input: string,
    init: RequestInit = {}
  ): Promise<Response> => {
    let token = await getActiveToken(false);
    if (!token) {
      throw new Error(
        `Unauthorized: Sign in with authorized owner Gmail (${AUTHORIZED_ADMIN_EMAIL}) to continue.`
      );
    }
    const resolvedInput = apiUrl(input);
    const baseHeaders = (init.headers as Record<string, string> | undefined) || {};
    let res = await fetch(resolvedInput, {
      ...init,
      credentials: "include",
      headers: buildAdminHeaders(token, baseHeaders),
    });
    if (res.status === 401) {
      const refreshed = await getActiveToken(true);
      if (refreshed) {
        token = refreshed;
        res = await fetch(resolvedInput, {
          ...init,
          credentials: "include",
          headers: buildAdminHeaders(token, baseHeaders),
        });
      }
    }
    return res;
  };

  // Load all anime including unpublished for admin
  const loadAdminAnime = async (showSpinner = true) => {
    if (showSpinner && !hasLoadedAdminRef.current) setIsLoading(true);
    try {
      const token = await getActiveToken(false);
      if (token) {
        const res = await adminFetch("/api/anime?includeUnpublished=true&safeMode=false");
        if (res.ok) {
          const data = await res.json();
          const serverItems: Anime[] = (data.anime || []).map((item: Anime) => ({
            ...item,
            genres: Array.isArray(item?.genres) ? item.genres : [],
          }));
          const map = new Map<string, Anime>();
          for (const item of serverItems) map.set(item.id, item);
          for (const item of catalogRef.current) {
            map.set(item.id, {
              ...item,
              genres: Array.isArray(item?.genres) ? item.genres : [],
            });
          }
          setAllAnime(Array.from(map.values()));
          hasLoadedAdminRef.current = true;
          return;
        }
      }
      setAllAnime(
        catalogRef.current.map((item) => ({
          ...item,
          genres: Array.isArray(item?.genres) ? item.genres : [],
        }))
      );
      hasLoadedAdminRef.current = true;
    } catch (err) {
      console.error("Admin fetch error:", err);
      setAllAnime(catalogRef.current);
    } finally {
      setIsLoading(false);
    }
  };

  const loadAdminInsights = async () => {
    setIsLoadingInsights(true);
    setInsightsError(null);
    try {
      const [statsRes, usersRes] = await Promise.all([
        adminFetch("/api/admin/stats"),
        adminFetch("/api/admin/users"),
      ]);
      if (statsRes.ok) {
        const sData = await statsRes.json();
        setAdminStats(sData.stats || null);
      }
      if (usersRes.ok) {
        const uData = await usersRes.json();
        setAdminUsers(Array.isArray(uData.users) ? uData.users : []);
      }
      if (!statsRes.ok || !usersRes.ok) {
        setInsightsError("Some server metrics could not be fetched. Ensure backend admin token is active.");
      }
    } catch (err: any) {
      setInsightsError(err?.message || "Failed to load admin statistics.");
    } finally {
      setIsLoadingInsights(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      loadAdminAnime(true);
      if (adminTab === "insights") {
        loadAdminInsights();
      }
    }
  }, [isAdmin, adminTab]);

  // Keep admin table synced from realtime catalog listeners without firing redundant API calls
  useEffect(() => {
    if (!isAdmin || catalog.length === 0) return;
    setAllAnime((prev) => {
      const map = new Map<string, Anime>();
      for (const item of prev) map.set(item.id, item);
      let changed = false;
      for (const item of catalog) {
        if (map.get(item.id) !== item) {
          map.set(item.id, item);
          changed = true;
        }
      }
      return changed ? Array.from(map.values()) : prev;
    });
  }, [catalog, isAdmin]);

  // Realtime episode subscription when managing episodes
  useEffect(() => {
    if (!managingAnimeEpisodes) return;
    const unsub = subscribeToAnimeEpisodes(
      managingAnimeEpisodes.id,
      true,
      (fbEpisodes) => {
        if (fbEpisodes.length > 0) {
          setEpisodesList((prev) => {
            const next = mergeEpisodeLists(prev, fbEpisodes);
            // If form is idle in Add mode with no URL typed yet, keep suggested episode # aligned cleanly
            if (
              !editingEpisodeId &&
              prev.length === 0 &&
              Object.values(epQualityUrls).every((v) => !v.trim())
            ) {
              const targetS = Math.max(1, parseInt(newEpSeasonInput, 10) || 1);
              const maxEpNum = next
                .filter((e) => (e.season || 1) === targetS)
                .reduce((max, e) => Math.max(max, e.number), 0);
              const nextNum = maxEpNum + 1;
              setNewEpNumberInput(String(nextNum));
              setNewEpTitle(`Episode ${nextNum}`);
            }
            return next;
          });
        }
      }
    );
    return () => unsub();
  }, [managingAnimeEpisodes?.id]);

  // Handle open modal for new or editing anime
  const openAddModal = () => {
    setEditingAnime(null);
    setFormTitle("");
    setFormJapanese("");
    setFormSynopsis("");
    setFormPoster("");
    setFormBanner("");
    setFormGenres("Action, Fantasy");
    setFormRatingSelect("");
    setFormCustomRating("");
    setFormRatingConfirmed(false);
    setFormStatus("Ongoing");
    setFormYearInput(String(new Date().getFullYear()));
    setFormSeasonsInput("1");
    setFormEpisodesInput("0");
    setFormIsPublished(true);
    setFormTrending(false);
    setFormStudio("");
    setFormAuthor("");
    setFormDirector("");
    setFormProductionCompany("");
    setFormCast([]);
    setFormQualityUrls(createEmptyQualityMap());
    setShowAllAnimeQualities(false);
    setAniListResults([]);
    setAniListQuery("");
    setAnimeVideoProgress(null);
    setAnimeVideoFileName("");
    setIsUploadingAnimeVideo(false);
    setAnimeUploadQualityTarget(null);
    setAnimeVideoFeedback(null);
    setModalFeedback(null);
    setShowAddEditModal(true);
    sound.playClick();
  };

  const openEditModal = (anime: Anime) => {
    setEditingAnime(anime);
    setFormTitle(anime.title);
    setFormJapanese(anime.titleJapanese || "");
    setFormSynopsis(anime.synopsis);
    setFormPoster(anime.posterImage || "");
    setFormBanner(anime.bannerImage || "");
    setFormGenres((Array.isArray(anime.genres) ? anime.genres : []).join(", "));
    const existingRating = String(anime.rating || "").trim();
    if (isPresetRating(existingRating)) {
      setFormRatingSelect(existingRating);
      setFormCustomRating("");
    } else if (existingRating) {
      setFormRatingSelect("Custom");
      setFormCustomRating(existingRating);
    } else {
      setFormRatingSelect("");
      setFormCustomRating("");
    }
    setFormRatingConfirmed(Boolean(existingRating));
    setFormStatus(anime.status);
    setFormYearInput(String(anime.year || new Date().getFullYear()));
    setFormSeasonsInput(String(anime.seasons || 1));
    setFormEpisodesInput(String(anime.episodesCount ?? 0));
    setFormIsPublished(anime.isPublished);
    setFormTrending(Boolean(anime.trending));
    setFormStudio(anime.studio || "");
    setFormAuthor(anime.author || "");
    setFormDirector(anime.director || "");
    setFormProductionCompany(anime.productionCompany || "");
    setFormCast(Array.isArray(anime.cast) ? anime.cast : []);

    const nextQ = createEmptyQualityMap();
    for (const s of anime.streamingSources || []) {
      if (!s?.url) continue;
      const norm = normalizeQualityCode(s.quality || s.name) as VideoQualityCode;
      if ((VIDEO_QUALITIES as readonly string[]).includes(norm) && !nextQ[norm]) {
        nextQ[norm] = s.url;
      } else if (!nextQ["1080p"]) {
        nextQ["1080p"] = s.url;
      }
    }
    setFormQualityUrls(nextQ);
    setShowAllAnimeQualities(Boolean(nextQ["2160p"] || nextQ["1440p"] || nextQ["360p"]));
    setAniListResults([]);
    setAnimeVideoProgress(null);
    setAnimeVideoFileName("");
    setIsUploadingAnimeVideo(false);
    setAnimeUploadQualityTarget(null);
    setAnimeVideoFeedback(null);
    setModalFeedback(null);
    setShowAddEditModal(true);
    sound.playClick();
  };

  // AniList Search
  const handleSearchAniList = async () => {
    if (!aniListQuery.trim()) return;
    setIsSearchingAniList(true);
    setModalFeedback(null);
    sound.playClick();
    try {
      const res = await fetch(apiUrl(`/api/anilist/search?q=${encodeURIComponent(aniListQuery.trim())}`));
      const data = await res.json();
      if (res.ok) {
        setAniListResults(data.results || []);
        if ((data.results || []).length === 0) {
          setModalFeedback({ text: "No AniList titles found matching that query.", isError: true });
        }
      } else {
        setModalFeedback({ text: data.error || "AniList search failed.", isError: true });
      }
    } catch {
      setModalFeedback({ text: "Network error reaching AniList.", isError: true });
    } finally {
      setIsSearchingAniList(false);
    }
  };

  const applyAniListResult = (result: any) => {
    setFormTitle(result.title);
    setFormJapanese(result.titleJapanese);
    setFormSynopsis(result.synopsis);
    if (result.posterImage) setFormPoster(result.posterImage);
    if (result.bannerImage) setFormBanner(result.bannerImage);
    if (result.genres && result.genres.length > 0) setFormGenres(result.genres.join(", "));
    if (result.year) setFormYearInput(String(result.year));
    if (typeof result.episodesCount === "number" && result.episodesCount >= 0) {
      setFormEpisodesInput(String(result.episodesCount));
    }
    if (result.rating) {
      const mapped = isPresetRating(result.rating) ? result.rating : "13+";
      setFormRatingSelect(mapped);
      setFormCustomRating("");
      // Never auto-confirm an age rating without explicit admin verification
      setFormRatingConfirmed(false);
    }
    if (result.status) setFormStatus(result.status);
    setFormStudio(result.studio || "");
    setFormAuthor(result.author || "");
    setFormDirector(result.director || "");
    setFormProductionCompany(result.productionCompany || result.studio || "");
    setFormCast(Array.isArray(result.cast) ? result.cast : []);
    setAniListResults([]);
    sound.playSuccess();
    setModalFeedback({
      text: `Auto-filled metadata, credits, and ${Array.isArray(result.cast) ? result.cast.length : 0} cast entries for "${result.title}". Confirm Age Rating before saving!`,
    });
    setTimeout(() => setModalFeedback(null), 4500);
  };

  const handleEnrichCreditsOnly = async () => {
    const q = formTitle.trim();
    if (!q) {
      setModalFeedback({ text: "Enter the Anime English Title first to fetch credits.", isError: true });
      return;
    }
    setIsFetchingCredits(true);
    setModalFeedback(null);
    sound.playClick();
    try {
      const res = await fetch(apiUrl(`/api/anilist/search?q=${encodeURIComponent(q)}`));
      const data = await res.json();
      const first = Array.isArray(data?.results) ? data.results[0] : null;
      if (!res.ok || !first) {
        setModalFeedback({ text: `No AniList credits found for "${q}".`, isError: true });
        return;
      }
      if (first.studio) setFormStudio(first.studio);
      if (first.author) setFormAuthor(first.author);
      if (first.director) setFormDirector(first.director);
      if (first.productionCompany) setFormProductionCompany(first.productionCompany);
      if (Array.isArray(first.cast) && first.cast.length > 0) setFormCast(first.cast);
      sound.playSuccess();
      setModalFeedback({
        text: `Enriched credits & ${Array.isArray(first.cast) ? first.cast.length : 0} cast members from AniList match "${first.title}".`,
      });
    } catch {
      setModalFeedback({ text: "Could not reach AniList to enrich credits.", isError: true });
    } finally {
      setIsFetchingCredits(false);
    }
  };

  // Compress gallery image into compact JPEG Data URL (for instant preview + reliable fallback)
  const fileToCompressedDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read image from gallery"));
      reader.onload = () => {
        const rawResult = reader.result as string;
        const img = new Image();
        img.onerror = () => resolve(rawResult);
        img.onload = () => {
          const maxDim = 1000;
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(rawResult);
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.src = rawResult;
      };
      reader.readAsDataURL(file);
    });

  // File upload handler (Poster / Banner from Phone Gallery or Disk)
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, targetField: "poster" | "banner") => {
    const file = e.target.files?.[0];
    // Always reset input so selecting the same gallery photo again fires onChange
    e.target.value = "";
    if (!file) return;

    let token = await getActiveToken();
    if (!token) {
      setModalFeedback({
        text: "Admin session missing. Please re-verify in Admin Portal before uploading.",
        isError: true,
      });
      sound.playError();
      return;
    }

    setIsUploadingFile(true);
    setUploadingTarget(targetField);
    setModalFeedback(null);
    sound.playClick();

    // Show immediate preview while uploading
    let compressedFallback = "";
    try {
      compressedFallback = await fileToCompressedDataUrl(file);
      if (targetField === "poster") setFormPoster(compressedFallback);
      if (targetField === "banner") setFormBanner(compressedFallback);
    } catch {
      // ignore preview error, continue with upload
    }

    const sendUpload = (tok: string) => {
      const formData = new FormData();
      formData.append("file", file);
      return fetch(apiUrl("/api/upload"), {
        method: "POST",
        credentials: "include",
        headers: buildAdminHeaders(tok),
        body: formData,
      });
    };

    try {
      let res = await sendUpload(token);
      if (res.status === 401 || res.status === 403) {
        const refreshed = await refreshAdminUploadToken();
        if (refreshed) {
          token = refreshed;
          res = await sendUpload(token);
        }
      }

      if (res.status === 401 || res.status === 403) {
        setModalFeedback({
          text: "Admin session expired. Please sign out and re-verify Admin Access to save.",
          isError: true,
        });
        sound.playError();
        return;
      }

      const data = await res.json();
      if (res.ok && data.url) {
        if (targetField === "poster") setFormPoster(data.url);
        if (targetField === "banner") setFormBanner(data.url);
        sound.playSuccess();
        setModalFeedback({
          text: `${targetField === "poster" ? "Poster" : "Banner"} uploaded & ready to save!`,
        });
        setTimeout(() => setModalFeedback(null), 3500);
      } else if (compressedFallback) {
        if (targetField === "poster") setFormPoster(compressedFallback);
        if (targetField === "banner") setFormBanner(compressedFallback);
        sound.playSuccess();
        setModalFeedback({
          text: `${targetField === "poster" ? "Poster" : "Banner"} loaded from gallery & ready to save!`,
        });
      } else {
        setModalFeedback({ text: data.error || "Upload failed", isError: true });
        sound.playError();
      }
    } catch {
      if (compressedFallback) {
        if (targetField === "poster") setFormPoster(compressedFallback);
        if (targetField === "banner") setFormBanner(compressedFallback);
        sound.playSuccess();
        setModalFeedback({
          text: `${targetField === "poster" ? "Poster" : "Banner"} saved from gallery & ready!`,
        });
      } else {
        setModalFeedback({ text: "Upload failed due to network error", isError: true });
        sound.playError();
      }
    } finally {
      setIsUploadingFile(false);
      setUploadingTarget(null);
    }
  };

  // Video Upload handler for Main Anime / Movie Modal (Per-Quality Gallery Picker -> Progress % -> Stream URL)
  const handleAnimeVideoUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    quality: VideoQualityCode = "1080p"
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const token = await getActiveToken(false);
    if (!token) {
      setAnimeVideoFeedback({
        text: `Unauthorized: Sign in with authorized owner Gmail (${AUTHORIZED_ADMIN_EMAIL}) before uploading videos.`,
        isError: true,
      });
      setModalFeedback({
        text: "Unauthorized: Missing or invalid admin authorization header.",
        isError: true,
      });
      sound.playError();
      return;
    }

    setIsUploadingAnimeVideo(true);
    setAnimeUploadQualityTarget(quality);
    setAnimeVideoFileName(file.name);
    setAnimeVideoProgress({
      percent: 0,
      bytesTransferred: 0,
      totalBytes: file.size,
      state: "running",
    });
    setModalFeedback(null);
    setAnimeVideoFeedback(null);
    sound.playClick();

    try {
      const downloadUrl = await uploadVideoWithChunkFallback(
        file,
        token,
        (info) => setAnimeVideoProgress(info),
        (handle) => {
          animeVideoTaskRef.current = handle;
        }
      );

      setFormQualityUrls((prev) => ({ ...prev, [quality]: downloadUrl }));

      sound.playSuccess();
      const okMsg = `${VIDEO_QUALITY_META[quality].fullLabel} video "${file.name}" uploaded & saved to this anime's quality list!`;
      setAnimeVideoFeedback({ text: okMsg });
      setModalFeedback({ text: okMsg });
    } catch (err: any) {
      sound.playError();
      const errMsg = err?.message || `${quality} video upload failed.`;
      setAnimeVideoFeedback({ text: errMsg, isError: true });
      setModalFeedback({ text: errMsg, isError: true });
    } finally {
      setIsUploadingAnimeVideo(false);
      setAnimeUploadQualityTarget(null);
      animeVideoTaskRef.current = null;
    }
  };

  // Save Anime (Create or Update; merges multiple qualities into same anime record instead of duplicating)
  const handleSaveAnime = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isUploadingFile || isUploadingAnimeVideo) {
      setModalFeedback({
        text: "Please wait — media upload is still in progress...",
        isError: true,
      });
      return;
    }
    if (!formTitle.trim()) {
      setModalFeedback({ text: "English Title is required.", isError: true });
      return;
    }
    if (!formPoster.trim()) {
      setModalFeedback({ text: "Poster Image URL or gallery upload is required.", isError: true });
      return;
    }

    const resolvedRating =
      formRatingSelect === "Custom" ? formCustomRating.trim() : formRatingSelect.trim();
    if (!isValidAgeRating(resolvedRating)) {
      setModalFeedback({
        text: "Please select an Age Rating (5+, 7+, 10+, 13+, 16+, 18+, or Custom).",
        isError: true,
      });
      return;
    }
    if (!formRatingConfirmed) {
      setModalFeedback({
        text: "Please check the Age Rating confirmation box before saving this record.",
        isError: true,
      });
      return;
    }

    const trimmedEpCount = formEpisodesInput.trim();
    if (!/^\d+$/.test(trimmedEpCount)) {
      setModalFeedback({
        text: "Episodes count must be a valid non-negative whole number (e.g. 0, 1, 11, 24, 100).",
        isError: true,
      });
      return;
    }
    const parsedEpisodesCount = Math.min(10000, parseInt(trimmedEpCount, 10));

    const trimmedSeasons = formSeasonsInput.trim();
    const parsedSeasons = /^\d+$/.test(trimmedSeasons)
      ? Math.max(1, Math.min(200, parseInt(trimmedSeasons, 10)))
      : 1;

    const trimmedYear = formYearInput.trim();
    const parsedYear = /^\d+$/.test(trimmedYear)
      ? Math.max(1950, Math.min(2100, parseInt(trimmedYear, 10)))
      : new Date().getFullYear();

    let token = await getActiveToken();
    const existingByTitle = !editingAnime
      ? allAnime.find((a) => a.title.trim().toLowerCase() === formTitle.trim().toLowerCase())
      : undefined;
    const targetExisting = editingAnime || existingByTitle || null;

    const recordId =
      targetExisting?.id ||
      `anime-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const nowIso = new Date().toISOString();

    const newQualitySources: { name: string; url: string; quality: string }[] = [];
    for (const qCode of VIDEO_QUALITIES) {
      const rawUrl = (formQualityUrls[qCode] || "").trim();
      if (!rawUrl) continue;
      const classified = classifyStreamUrl(rawUrl);
      if (classified.kind === "invalid") {
        setModalFeedback({
          text: `${qCode}: ${classified.error || "Invalid streaming URL."}`,
          isError: true,
        });
        return;
      }
      newQualitySources.push({
        name: VIDEO_QUALITY_META[qCode].fullLabel,
        url: classified.url,
        quality: qCode,
      });
    }

    let finalStreamingSources = newQualitySources;
    if (!editingAnime && existingByTitle) {
      const mergedMap = new Map<string, { name: string; url: string; quality: string }>();
      for (const s of existingByTitle.streamingSources || []) {
        if (s?.url) {
          const norm = normalizeQualityCode(s.quality || s.name);
          mergedMap.set(norm.toLowerCase(), {
            name: s.name,
            url: s.url,
            quality: norm,
          });
        }
      }
      for (const s of newQualitySources) {
        if (s?.url) mergedMap.set(s.quality.toLowerCase(), s);
      }
      finalStreamingSources = Array.from(mergedMap.values());
    }

    const resolvedSynopsis =
      formSynopsis.trim() ||
      targetExisting?.synopsis ||
      `Stream ${formTitle.trim()} in high speed on YG Flash Anime.`;

    const cleanCast = formCast
      .map((c) => ({
        characterName: String(c.characterName || "").trim(),
        voiceActor: String(c.voiceActor || "").trim(),
        ...(c.characterImage?.trim() ? { characterImage: c.characterImage.trim() } : {}),
        ...(c.language?.trim() ? { language: c.language.trim() } : {}),
        ...(c.role?.trim() ? { role: c.role.trim() } : {}),
      }))
      .filter((c) => c.characterName || c.voiceActor);

    const animeRecord: Anime = {
      id: recordId,
      title: formTitle.trim(),
      titleJapanese: formJapanese.trim(),
      synopsis: resolvedSynopsis,
      posterImage: formPoster.trim(),
      bannerImage: formBanner.trim() || formPoster.trim(),
      genres: formGenres.split(",").map((g) => g.trim()).filter(Boolean),
      rating: resolvedRating,
      ratingVerified: true,
      status: formStatus,
      year: parsedYear,
      seasons: parsedSeasons,
      episodesCount: parsedEpisodesCount,
      isPublished: formIsPublished,
      featured: targetExisting?.featured ?? false,
      trending: formTrending,
      ...(formStudio.trim() ? { studio: formStudio.trim() } : {}),
      ...(formAuthor.trim() ? { author: formAuthor.trim() } : {}),
      ...(formDirector.trim() ? { director: formDirector.trim() } : {}),
      ...(formProductionCompany.trim() ? { productionCompany: formProductionCompany.trim() } : {}),
      ...(cleanCast.length > 0 ? { cast: cleanCast } : {}),
      streamingSources: finalStreamingSources,
      createdAt: targetExisting?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    try {
      const isUpdateOp = Boolean(targetExisting);
      const fbPromise = saveAnimeToFirebase(animeRecord, !isUpdateOp);

      const sendSaveToServer = async (tok: string) => {
        return fetch(apiUrl(isUpdateOp ? `/api/admin/anime/${recordId}` : "/api/admin/anime"), {
          method: isUpdateOp ? "PUT" : "POST",
          credentials: "include",
          headers: buildAdminHeaders(tok, { "Content-Type": "application/json" }),
          body: JSON.stringify(animeRecord),
        });
      };

      const serverPromise = token
        ? sendSaveToServer(token).then(async (res) => {
            if (res.status === 401 || res.status === 403) {
              const refreshed = await refreshAdminUploadToken();
              if (refreshed) {
                token = refreshed;
                return sendSaveToServer(refreshed);
              }
            }
            return res;
          })
        : Promise.resolve(null);

      const [fbResult, serverRes] = await Promise.all([fbPromise, serverPromise]);

      if (targetExisting && targetExisting.isPublished !== animeRecord.isPublished) {
        await syncAnimePublishToEpisodesInFirebase(recordId, animeRecord.isPublished).catch(() => {});
      }

      let serverOk = false;
      let serverError = "";
      if (serverRes) {
        if (serverRes.ok) {
          serverOk = true;
        } else {
          const data = await serverRes.json().catch(() => ({}));
          serverError = data.error || "";
        }
      }

      const cloudSynced = fbResult.rtdbSaved || fbResult.firestoreSaved;
      if (cloudSynced || serverOk) {
        sound.playSuccess();
        const warningNote = !cloudSynced
          ? isFirebaseAdminAuthenticated
            ? ` (Cloud sync failed: ${fbResult.error || "check connection"})`
            : " (Server session only — connect Google Cloud Sync to save permanently!)"
          : "";
        setStatusMessage({
          text: existingByTitle
            ? `Quality streams merged into "${existingByTitle.title}"${warningNote}`
            : `Anime ${editingAnime ? "updated" : "published"}${warningNote}`,
        });
        setModalFeedback(null);
        setAnimeVideoFeedback(null);
        setShowAddEditModal(false);
        await Promise.all([loadAdminAnime(), refreshCatalog()]);
        setTimeout(() => setStatusMessage(null), 5000);
      } else {
        setModalFeedback({
          text:
            fbResult.error ||
            serverError ||
            "Failed to save anime to Firebase or server. Please check admin session.",
          isError: true,
        });
        sound.playError();
      }
    } catch (err: any) {
      setModalFeedback({ text: err?.message || "Network error saving anime.", isError: true });
      sound.playError();
    }
  };

  // Delete Anime
  const handleDeleteAnime = async () => {
    if (!animeToDelete) return;
    const target = animeToDelete;
    sound.playClick();

    setAllAnime((prev) => prev.filter((a) => a.id !== target.id));
    setAnimeToDelete(null);

    const token = await getActiveToken();

    try {
      await deleteAnimeFromFirebase(target.id);
      if (token) {
        await fetch(apiUrl(`/api/admin/anime/${target.id}`), {
          method: "DELETE",
          credentials: "include",
          headers: buildAdminHeaders(token),
        });
      }
      sound.playSuccess();
      setStatusMessage({ text: `Anime "${target.title}" permanently deleted.` });
      await refreshCatalog();
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: any) {
      setStatusMessage({ text: err?.message || "Error deleting anime.", isError: true });
      loadAdminAnime();
    }
  };

  // Toggle Publish (propagates publish state to parent anime AND all of its episodes)
  const handleTogglePublish = async (anime: Anime) => {
    sound.playClick();
    const updatedAnime: Anime = {
      ...anime,
      isPublished: !anime.isPublished,
      updatedAt: new Date().toISOString(),
    };
    const token = await getActiveToken();
    try {
      await Promise.all([
        saveAnimeToFirebase(updatedAnime, false),
        syncAnimePublishToEpisodesInFirebase(anime.id, updatedAnime.isPublished),
        token
          ? fetch(apiUrl(`/api/admin/anime/${anime.id}`), {
              method: "PUT",
              credentials: "include",
              headers: buildAdminHeaders(token, { "Content-Type": "application/json" }),
              body: JSON.stringify({ isPublished: updatedAnime.isPublished }),
            })
          : Promise.resolve(null),
      ]);
      loadAdminAnime();
      refreshCatalog();
    } catch (err) {
      console.error("Toggle publish error:", err);
    }
  };

  const buildBulkRows = (
    start: number,
    end: number,
    pastedText = "",
    titlePattern = "Episode {n}",
    sharedThumb = "",
    sharedDesc = "",
    useSharedSingleUrl = false,
    singleUrl = ""
  ) => {
    const safeStart = Math.max(1, Math.min(10000, Math.round(start) || 1));
    const safeEnd = Math.max(safeStart, Math.min(safeStart + 99, Math.round(end) || safeStart));
    const lines = pastedText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const pattern = titlePattern.trim() || "Episode {n}";
    const rows = [];
    for (let epNum = safeStart, idx = 0; epNum <= safeEnd; epNum++, idx++) {
      const resolvedTitle = pattern.includes("{n}")
        ? pattern.replace(/\{n\}/g, String(epNum))
        : `${pattern} ${epNum}`;
      rows.push({
        key: `bulk-${epNum}-${Date.now()}-${idx}`,
        number: epNum,
        title: resolvedTitle,
        videoUrl:
          useSharedSingleUrl && singleUrl.trim() ? singleUrl.trim() : lines[idx] || "",
        thumbnailUrl: sharedThumb.trim(),
        description: sharedDesc.trim(),
      });
    }
    return rows;
  };

  const resetEpisodeFormForCreate = (currentEps: Episode[], targetSeason = 1) => {
    const seasonEps = currentEps.filter((e) => (e.season || 1) === targetSeason);
    const maxEpNum = seasonEps.reduce((max, e) => Math.max(max, e.number), 0);
    const nextNum = maxEpNum + 1;
    setEditingEpisodeId(null);
    setNewEpSeasonInput(String(targetSeason));
    setNewEpNumberInput(String(nextNum));
    setNewEpTitle(`Episode ${nextNum}`);
    setNewEpLanguagePreset("Japanese");
    setNewEpCustomLanguage("");
    setNewEpReleaseDate("");
    setNewEpBunnyVideoId("");
    setNewEpThumbnailUrl("");
    setNewEpDescription("");
    setHlsInspectState(null);
    setEpQualityUrls(createEmptyQualityMap());
    setShowAllEpQualities(false);
    setEpVideoProgress(null);
    setEpVideoFileName("");
    setEpVideoFeedback(null);
  };

  // Open Episodes Manager
  const openEpisodesManager = async (anime: Anime) => {
    setManagingAnimeEpisodes(anime);
    setEpisodesList([]);
    setEpManagerMode("single");
    setEditingEpisodeId(null);
    setEpVideoProgress(null);
    setEpVideoFileName("");
    setEpUploadQualityTarget(null);
    setEpModalFeedback(null);
    setEpVideoFeedback(null);
    setEpSearchQuery("");
    setEpSeasonFilter("ALL");
    setEpLanguageFilter("ALL");
    setEpSortBy("order");
    setBulkSeasonInput("1");
    setBulkLanguagePreset("Japanese");
    setBulkCustomLanguage("");
    setBulkStartEpInput("1");
    setBulkEndEpInput("5");
    setBulkTitlePattern("Episode {n}");
    setBulkSharedThumb("");
    setBulkSharedDesc("");
    setBulkAllowSharedUrl(false);
    setBulkSharedSingleUrl("");
    setBulkPasteUrls("");
    setBulkRows(buildBulkRows(1, 5));
    sound.playClick();
    try {
      const tok = await getActiveToken(false);
      const [res, fbEpisodes] = await Promise.all([
        fetch(apiUrl(`/api/anime/${anime.id}`), {
          headers: buildAdminHeaders(tok),
          credentials: "include",
        }).catch(() => null),
        fetchAnimeEpisodesOnce(anime.id, true).catch(() => [] as Episode[]),
      ]);
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      const serverEps: Episode[] = Array.isArray(data?.episodes) ? data.episodes : [];
      const merged = mergeEpisodeLists(serverEps, fbEpisodes);
      setEpisodesList(merged);
      resetEpisodeFormForCreate(merged, 1);
    } catch (err) {
      console.error(err);
      setEpisodesList([]);
      resetEpisodeFormForCreate([], 1);
    }
  };

  // Start explicitly creating a brand new episode entry
  const handleStartAddNewEpisode = () => {
    sound.playClick();
    setEpManagerMode("single");
    setEpModalFeedback(null);
    const parsedSeason = Math.max(1, parseInt(newEpSeasonInput, 10) || 1);
    resetEpisodeFormForCreate(episodesList, parsedSeason);
    epFormRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  // Load an existing episode into Edit Mode
  const handleStartEditEpisode = (ep: Episode) => {
    sound.playClick();
    setEpManagerMode("single");
    setEditingEpisodeId(ep.id);
    setNewEpSeasonInput(String(ep.season || 1));
    setNewEpNumberInput(String(ep.number || 1));
    setNewEpTitle(ep.title || `Episode ${ep.number}`);
    const existingLang = String(ep.language || "Japanese").trim();
    if (isPresetLanguage(existingLang)) {
      setNewEpLanguagePreset(existingLang);
      setNewEpCustomLanguage("");
    } else {
      setNewEpLanguagePreset("Other");
      setNewEpCustomLanguage(existingLang);
    }
    setNewEpReleaseDate(ep.releaseDate || "");
    setNewEpBunnyVideoId(ep.bunnyVideoId || "");
    setNewEpThumbnailUrl(ep.thumbnailUrl || "");
    setNewEpDescription(ep.description ?? ep.synopsis ?? "");
    setHlsInspectState(null);

    const nextQ = createEmptyQualityMap();
    if (Array.isArray(ep.sources)) {
      for (const s of ep.sources) {
        if (!s?.url) continue;
        const norm = normalizeQualityCode(s.quality || s.label) as VideoQualityCode;
        if ((VIDEO_QUALITIES as readonly string[]).includes(norm) && !nextQ[norm]) {
          nextQ[norm] = s.url;
        }
      }
    }
    if (ep.videoUrl && !Object.values(nextQ).some((u) => u === ep.videoUrl)) {
      if (!nextQ["1080p"]) nextQ["1080p"] = ep.videoUrl;
    }
    setEpQualityUrls(nextQ);
    setShowAllEpQualities(Boolean(nextQ["2160p"] || nextQ["1440p"] || nextQ["360p"]));
    setEpVideoProgress(null);
    setEpVideoFileName("");
    setEpVideoFeedback(null);
    setEpModalFeedback(null);
    epFormRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  // Upload optional Episode Thumbnail from gallery
  const handleEpThumbnailUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setIsUploadingEpThumb(true);
    setEpModalFeedback(null);
    sound.playClick();
    let compressedFallback = "";
    try {
      compressedFallback = await fileToCompressedDataUrl(file);
      setNewEpThumbnailUrl(compressedFallback);
    } catch {}
    try {
      const token = await getActiveToken();
      if (token) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(apiUrl("/api/upload"), {
          method: "POST",
          credentials: "include",
          headers: buildAdminHeaders(token),
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.url) {
          setNewEpThumbnailUrl(data.url);
        }
      }
      sound.playSuccess();
    } catch {
      if (compressedFallback) setNewEpThumbnailUrl(compressedFallback);
    } finally {
      setIsUploadingEpThumb(false);
    }
  };

  // Video Upload handler for Episodes (Per-Quality Gallery Video Picker -> Progress % -> Stream URL)
  const handleVideoUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    quality: VideoQualityCode = "1080p"
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const token = await getActiveToken(false);
    if (!token) {
      const errMsg = `Unauthorized: Sign in with authorized owner Gmail (${AUTHORIZED_ADMIN_EMAIL}) before uploading episode videos.`;
      setEpVideoFeedback({ text: errMsg, isError: true });
      setEpModalFeedback({ text: errMsg, isError: true });
      sound.playError();
      return;
    }

    setIsUploadingVideo(true);
    setEpUploadQualityTarget(quality);
    setEpVideoFileName(file.name);
    setEpVideoProgress({
      percent: 0,
      bytesTransferred: 0,
      totalBytes: file.size,
      state: "running",
    });
    setEpModalFeedback(null);
    setEpVideoFeedback(null);
    sound.playClick();

    try {
      const downloadUrl = await uploadVideoWithChunkFallback(
        file,
        token,
        (info) => setEpVideoProgress(info),
        (handle) => {
          epUploadTaskRef.current = handle;
        }
      );

      setEpQualityUrls((prev) => ({ ...prev, [quality]: downloadUrl }));

      sound.playSuccess();
      const okMsg = `${VIDEO_QUALITY_META[quality].fullLabel} episode video uploaded & stream URL ready!`;
      setEpVideoFeedback({ text: okMsg });
      setEpModalFeedback({ text: okMsg });
    } catch (err: any) {
      sound.playError();
      const errMsg = err?.message || `${quality} episode video upload failed.`;
      setEpVideoFeedback({ text: errMsg, isError: true });
      setEpModalFeedback({ text: errMsg, isError: true });
    } finally {
      setIsUploadingVideo(false);
      setEpUploadQualityTarget(null);
      epUploadTaskRef.current = null;
    }
  };

  // Save Episode (Create New Episode OR Update explicitly selected Episode — ALWAYS stays inside managingAnimeEpisodes.id)
  const handleSaveEpisode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!managingAnimeEpisodes) return;

    const hasAnyQualityUrl = VIDEO_QUALITIES.some((q) => epQualityUrls[q].trim().length > 0);
    if (!hasAnyQualityUrl) {
      setEpModalFeedback({ text: "Upload or paste at least one valid Video URL.", isError: true });
      return;
    }
    if (isUploadingVideo || isUploadingEpThumb) {
      setEpModalFeedback({ text: "Wait for the media upload to finish.", isError: true });
      return;
    }

    const epSeasonNum = parseInt(newEpSeasonInput.trim(), 10);
    if (!Number.isFinite(epSeasonNum) || epSeasonNum < 1 || epSeasonNum > 200) {
      setEpModalFeedback({ text: "Season must be a whole number (1–200).", isError: true });
      return;
    }
    const epNum = parseInt(newEpNumberInput.trim(), 10);
    if (!Number.isFinite(epNum) || epNum < 1 || epNum > 10000) {
      setEpModalFeedback({ text: "Episode number must be a whole number (1–10000).", isError: true });
      return;
    }

    const resolvedLanguage =
      newEpLanguagePreset === "Other"
        ? newEpCustomLanguage.trim().slice(0, 40)
        : newEpLanguagePreset.trim();
    if (!resolvedLanguage) {
      setEpModalFeedback({ text: "Enter a custom audio language name.", isError: true });
      return;
    }

    const sources: { label: string; url: string; quality: string; type: string }[] = [];
    for (const qCode of VIDEO_QUALITIES) {
      const raw = (epQualityUrls[qCode] || "").trim();
      if (!raw) continue;
      const classified = classifyStreamUrl(raw);
      if (classified.kind === "invalid") {
        setEpModalFeedback({
          text: `${qCode}: ${classified.error || "Invalid streaming URL."}`,
          isError: true,
        });
        return;
      }
      const streamType = getStreamMimeType(classified.url);
      sources.push({
        label:
          classified.kind === "hls"
            ? "Bunny / HLS Adaptive (.m3u8)"
            : VIDEO_QUALITY_META[qCode].fullLabel,
        url: classified.url,
        quality: qCode,
        type: streamType,
      });
    }

    const primaryUrl =
      sources.find((s) => s.quality === "1080p")?.url || sources[0]?.url || "";

    const isEditing = Boolean(editingEpisodeId);
    const existingTarget = isEditing
      ? episodesList.find((ep) => ep.id === editingEpisodeId)
      : undefined;

    const epId =
      existingTarget?.id ||
      `ep-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const nowIso = new Date().toISOString();
    const maxOrder = episodesList.reduce((m, ep) => Math.max(m, ep.order ?? ep.number ?? 0), 0);
    const cleanDesc = newEpDescription.trim();

    const episodePayload: Episode = {
      id: epId,
      animeId: managingAnimeEpisodes.id,
      number: epNum,
      season: epSeasonNum,
      title: newEpTitle.trim() || `Episode ${epNum}`,
      language: resolvedLanguage,
      synopsis: cleanDesc,
      description: cleanDesc,
      duration: existingTarget?.duration || "24m",
      ...(newEpReleaseDate.trim() ? { releaseDate: newEpReleaseDate.trim() } : {}),
      ...(newEpBunnyVideoId.trim() ? { bunnyVideoId: newEpBunnyVideoId.trim() } : {}),
      videoUrl: primaryUrl,
      thumbnailUrl: newEpThumbnailUrl.trim(),
      order: isEditing ? (existingTarget?.order ?? epNum) : maxOrder + 1,
      isPublished: existingTarget?.isPublished ?? managingAnimeEpisodes.isPublished,
      sources,
      createdAt: existingTarget?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    setIsSavingEpisode(true);
    setEpModalFeedback(null);

    try {
      let token = await getActiveToken();
      const sendEpToServer = (tok: string) =>
        fetch(apiUrl(isEditing ? `/api/admin/episodes/${epId}` : "/api/admin/episodes"), {
          method: isEditing ? "PUT" : "POST",
          credentials: "include",
          headers: buildAdminHeaders(tok, { "Content-Type": "application/json" }),
          body: JSON.stringify({
            ...episodePayload,
            isPublished: managingAnimeEpisodes.isPublished,
            parentAnime: managingAnimeEpisodes,
          }),
        });

      const serverPromise = token
        ? sendEpToServer(token).then(async (res) => {
            if (res.status === 401 || res.status === 403) {
              const refreshed = await refreshAdminUploadToken();
              if (refreshed) {
                token = refreshed;
                return sendEpToServer(refreshed);
              }
            }
            return res;
          })
        : Promise.resolve(null);

      const fbPromise = saveEpisodeToFirebase(
        episodePayload,
        managingAnimeEpisodes.isPublished,
        !isEditing,
        managingAnimeEpisodes
      );

      const [serverRes, fbRes] = await Promise.all([serverPromise, fbPromise]);
      const serverData = serverRes ? await serverRes.json().catch(() => ({})) : {};
      const serverOk = Boolean(serverRes && serverRes.ok);

      if (!serverOk && serverData?.error) {
        setEpModalFeedback({ text: serverData.error, isError: true });
        sound.playError();
        return;
      }

      const cloudSaved = fbRes.rtdbSaved || fbRes.firestoreSaved;
      if (serverOk || cloudSaved) {
        const savedEp: Episode = serverData?.episode || episodePayload;
        const nextList = sortEpisodes([
          ...episodesList.filter((p) => p.id !== savedEp.id),
          savedEp,
        ]);
        setEpisodesList(nextList);
        sound.playSuccess();
        resetEpisodeFormForCreate(nextList, epSeasonNum);
        const cloudNote = !cloudSaved
          ? isFirebaseAdminAuthenticated
            ? ` — Warning: Firebase Cloud write failed (${fbRes.error || "network error"}).`
            : " — Temporary server session only! Connect Google Cloud Sync in Admin Dashboard so episodes stay permanent."
          : ` — Synced to Firebase Cloud (${nextList.length} total).`;
        setEpModalFeedback({
          text: isEditing
            ? `Updated S${savedEp.season || 1} · E${savedEp.number} (${savedEp.language})${cloudNote}`
            : `Added S${savedEp.season || 1} · E${savedEp.number} (${savedEp.language})${cloudNote}`,
        });
        refreshCatalog();
        setTimeout(() => setEpModalFeedback(null), 5000);
      } else {
        setEpModalFeedback({
          text: fbRes.error || "Failed to save episode to Firebase or server.",
          isError: true,
        });
        sound.playError();
      }
    } catch (err: any) {
      setEpModalFeedback({ text: err?.message || "Error saving episode.", isError: true });
      sound.playError();
    } finally {
      setIsSavingEpisode(false);
    }
  };

  // Bulk Add Episodes Handler (validates every row before saving, never overwrites existing anime)
  const handleSaveBulkEpisodes = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!managingAnimeEpisodes) return;
    if (bulkRows.length === 0) {
      setEpModalFeedback({ text: "Generate at least 1 episode row first.", isError: true });
      return;
    }
    if (bulkRows.length > 100) {
      setEpModalFeedback({ text: "Maximum 100 episodes per bulk batch.", isError: true });
      return;
    }

    const parsedBulkSeason = parseInt(bulkSeasonInput.trim(), 10);
    if (!Number.isFinite(parsedBulkSeason) || parsedBulkSeason < 1 || parsedBulkSeason > 200) {
      setEpModalFeedback({ text: "Bulk Season must be a whole number (1–200).", isError: true });
      return;
    }
    const resolvedBulkLang =
      bulkLanguagePreset === "Other"
        ? bulkCustomLanguage.trim().slice(0, 40)
        : bulkLanguagePreset.trim();
    if (!resolvedBulkLang) {
      setEpModalFeedback({ text: "Enter a custom bulk language name.", isError: true });
      return;
    }

    const maxOrder = episodesList.reduce((m, ep) => Math.max(m, ep.order ?? ep.number ?? 0), 0);
    const nowIso = new Date().toISOString();
    const prepared: Episode[] = [];
    const seenInBatch = new Set<string>();

    for (let i = 0; i < bulkRows.length; i++) {
      const row = bulkRows[i];
      const epNum = Math.round(Number(row.number));
      if (!Number.isFinite(epNum) || epNum < 1 || epNum > 10000) {
        setEpModalFeedback({
          text: `Row ${i + 1}: Episode number must be between 1 and 10000.`,
          isError: true,
        });
        sound.playError();
        return;
      }
      const batchKey = `${parsedBulkSeason}::${epNum}::${resolvedBulkLang.toLowerCase()}`;
      if (seenInBatch.has(batchKey)) {
        setEpModalFeedback({
          text: `Duplicate Episode ${epNum} (${resolvedBulkLang}) in bulk list at Row ${i + 1}.`,
          isError: true,
        });
        sound.playError();
        return;
      }
      seenInBatch.add(batchKey);

      const rawUrl = row.videoUrl.trim();
      if (!rawUrl) {
        setEpModalFeedback({
          text: `Episode ${epNum} (Row ${i + 1}) is missing a Video URL.`,
          isError: true,
        });
        sound.playError();
        return;
      }
      const classified = classifyStreamUrl(rawUrl);
      if (classified.kind === "invalid") {
        setEpModalFeedback({
          text: `Episode ${epNum} (Row ${i + 1}): ${classified.error || "Invalid Video URL."}`,
          isError: true,
        });
        sound.playError();
        return;
      }
      const streamType = getStreamMimeType(classified.url);
      const cleanDesc = (row.description || bulkSharedDesc).trim();
      const cleanThumb = (row.thumbnailUrl || bulkSharedThumb).trim();

      prepared.push({
        id: `ep-${Date.now()}-${i + 1}-${Math.random().toString(36).substring(2, 6)}`,
        animeId: managingAnimeEpisodes.id,
        number: epNum,
        season: parsedBulkSeason,
        title: row.title.trim() || `Episode ${epNum}`,
        language: resolvedBulkLang,
        synopsis: cleanDesc,
        description: cleanDesc,
        duration: "24m",
        videoUrl: classified.url,
        thumbnailUrl: cleanThumb,
        order: maxOrder + i + 1,
        sources: [
          {
            label: classified.kind === "hls" ? "Bunny / HLS Adaptive (.m3u8)" : "1080p Full HD",
            url: classified.url,
            quality: "1080p",
            type: streamType,
          },
        ],
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }

    setIsSavingBulk(true);
    setEpModalFeedback(null);

    try {
      let token = await getActiveToken();
      const sendBulk = (tok: string) =>
        fetch(apiUrl("/api/admin/episodes/bulk"), {
          method: "POST",
          credentials: "include",
          headers: buildAdminHeaders(tok, { "Content-Type": "application/json" }),
          body: JSON.stringify({
            animeId: managingAnimeEpisodes.id,
            episodes: prepared,
            isPublished: managingAnimeEpisodes.isPublished,
            parentAnime: managingAnimeEpisodes,
          }),
        });

      const serverPromise = token
        ? sendBulk(token).then(async (res) => {
            if (res.status === 401 || res.status === 403) {
              const refreshed = await refreshAdminUploadToken();
              if (refreshed) {
                token = refreshed;
                return sendBulk(refreshed);
              }
            }
            return res;
          })
        : Promise.resolve(null);

      const [serverRes, fbRes] = await Promise.all([
        serverPromise,
        saveBulkEpisodesToFirebase(
          prepared,
          managingAnimeEpisodes.isPublished,
          managingAnimeEpisodes
        ),
      ]);

      const serverData = serverRes ? await serverRes.json().catch(() => ({})) : {};
      const serverOk = Boolean(serverRes && serverRes.ok);

      if (!serverOk && serverData?.error) {
        setEpModalFeedback({ text: serverData.error, isError: true });
        sound.playError();
        return;
      }

      const cloudBulkSaved = fbRes.rtdbSavedCount > 0 || fbRes.firestoreSavedCount > 0;
      if (serverOk || cloudBulkSaved) {
        const createdEps: Episode[] = Array.isArray(serverData?.episodes)
          ? serverData.episodes
          : prepared;
        const nextList = sortEpisodes([...episodesList, ...createdEps]);
        setEpisodesList(nextList);
        sound.playSuccess();
        setEpManagerMode("single");
        resetEpisodeFormForCreate(nextList, parsedBulkSeason);
        setEpModalFeedback({
          text: cloudBulkSaved
            ? `Saved ${createdEps.length} episodes to Firebase Cloud for ${managingAnimeEpisodes.title} (Season ${parsedBulkSeason} · ${resolvedBulkLang})!`
            : `Saved ${createdEps.length} episodes to server session only! Connect Google Cloud Sync in Admin Dashboard to keep them permanent.`,
        });
        refreshCatalog();
      } else {
        setEpModalFeedback({ text: "Failed to save bulk episodes.", isError: true });
        sound.playError();
      }
    } catch (err: any) {
      setEpModalFeedback({ text: err?.message || "Bulk upload failed.", isError: true });
      sound.playError();
    } finally {
      setIsSavingBulk(false);
    }
  };

  // Reorder Episodes persistently within the same season
  const handleMoveEpisode = async (episodeId: string, direction: "up" | "down") => {
    if (!managingAnimeEpisodes) return;
    const movingEp = episodesList.find((e) => e.id === episodeId);
    if (!movingEp) return;
    const targetSeason = movingEp.season || 1;
    const seasonIndices = episodesList
      .map((e, idx) => ((e.season || 1) === targetSeason ? idx : -1))
      .filter((idx) => idx !== -1);

    const currentPosInSeason = seasonIndices.findIndex(
      (idx) => episodesList[idx].id === episodeId
    );
    if (currentPosInSeason === -1) return;
    const swapPosInSeason =
      direction === "up" ? currentPosInSeason - 1 : currentPosInSeason + 1;
    if (swapPosInSeason < 0 || swapPosInSeason >= seasonIndices.length) return;

    const currentIndex = seasonIndices[currentPosInSeason];
    const targetIndex = seasonIndices[swapPosInSeason];

    const reordered = [...episodesList];
    const temp = reordered[currentIndex];
    reordered[currentIndex] = reordered[targetIndex];
    reordered[targetIndex] = temp;

    const withUpdatedOrder = reordered.map((ep, idx) => ({
      ...ep,
      order: idx + 1,
      updatedAt: new Date().toISOString(),
    }));
    setEpisodesList(withUpdatedOrder);
    sound.playClick();

    try {
      const token = await getActiveToken();
      await Promise.all([
        token
          ? fetch(apiUrl("/api/admin/episodes/reorder"), {
              method: "POST",
              credentials: "include",
              headers: buildAdminHeaders(token, { "Content-Type": "application/json" }),
              body: JSON.stringify({
                animeId: managingAnimeEpisodes.id,
                orderedEpisodeIds: withUpdatedOrder.map((e) => e.id),
              }),
            })
          : Promise.resolve(null),
        reorderEpisodesInFirebase(
          managingAnimeEpisodes.id,
          withUpdatedOrder,
          managingAnimeEpisodes.isPublished
        ),
      ]);
      refreshCatalog();
    } catch (err) {
      console.error("Failed to reorder episodes:", err);
    }
  };

  const handleInspectHlsUrl = async () => {
    const raw = epQualityUrls["1080p"].trim();
    if (!raw) return;
    setHlsInspectState({ loading: true });
    sound.playClick();
    try {
      const res = await fetch(apiUrl(`/api/stream/hls-inspect?url=${encodeURIComponent(raw)}`));
      const data = await res.json();
      if (!res.ok) {
        setHlsInspectState({ loading: false, error: data.error || "Failed to inspect HLS playlist." });
        return;
      }
      setHlsInspectState({
        loading: false,
        variants: Array.isArray(data.variants) ? data.variants : [],
      });
    } catch {
      setHlsInspectState({ loading: false, error: "Network error inspecting HLS playlist." });
    }
  };

  const handleToggleEpisodePublish = async (ep: Episode) => {
    if (!managingAnimeEpisodes) return;
    sound.playClick();
    const currentlyPublished = ep.isPublished !== false;
    const nextPublished = !currentlyPublished;
    const updatedEp: Episode = {
      ...ep,
      isPublished: nextPublished,
      updatedAt: new Date().toISOString(),
    };
    setEpisodesList((prev) => prev.map((item) => (item.id === ep.id ? updatedEp : item)));
    try {
      const token = await getActiveToken();
      await Promise.all([
        saveEpisodeToFirebase(updatedEp, nextPublished, false, managingAnimeEpisodes),
        token
          ? fetch(apiUrl(`/api/admin/episodes/${ep.id}`), {
              method: "PUT",
              credentials: "include",
              headers: buildAdminHeaders(token, { "Content-Type": "application/json" }),
              body: JSON.stringify({ isPublished: nextPublished }),
            })
          : Promise.resolve(null),
      ]);
      refreshCatalog();
      setEpModalFeedback({
        text: `S${ep.season || 1}·E${ep.number} set to ${nextPublished ? "Live (Published)" : "Draft (Hidden)"}.`,
      });
    } catch (err: any) {
      setEpModalFeedback({ text: err?.message || "Failed to toggle episode visibility.", isError: true });
    }
  };

  // Delete Episode
  const handleDeleteEpisode = async (epId: string) => {
    if (!managingAnimeEpisodes) return;
    const token = await getActiveToken();
    try {
      await deleteEpisodeFromFirebase(managingAnimeEpisodes.id, epId);
      if (token) {
        await fetch(apiUrl(`/api/admin/episodes/${epId}`), {
          method: "DELETE",
          credentials: "include",
          headers: buildAdminHeaders(token),
        });
      }
      setEpisodesList((prev) => prev.filter((e) => e.id !== epId));
      if (editingEpisodeId === epId) {
        setEditingEpisodeId(null);
      }
      sound.playClick();
      refreshCatalog();
    } catch (err) {
      console.error(err);
    }
  };

  const handleSyncCatalogToCloud = async () => {
    setIsSyncingCloud(true);
    setStatusMessage(null);
    sound.playClick();
    try {
      const token = await getActiveToken(true);
      if (!token) {
        setStatusMessage({
          text: `Unauthorized: Sign in with authorized owner Gmail (${AUTHORIZED_ADMIN_EMAIL}) to sync catalog.`,
          isError: true,
        });
        sound.playError();
        return;
      }
      const synced = await syncLocalCatalogAndEpisodesToFirebase(allAnime, token);
      sound.playSuccess();
      setStatusMessage({
        text: `Cloud Sync complete! Synced ${synced.animeSynced} anime & ${synced.episodesSynced} episodes permanently to Firebase.`,
      });
      await Promise.all([loadAdminAnime(false), refreshCatalog()]);
    } catch (err: any) {
      sound.playError();
      setStatusMessage({
        text: err?.message || "Could not sync catalog to Firebase Cloud.",
        isError: true,
      });
    } finally {
      setIsSyncingCloud(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="max-w-md mx-auto p-8 text-center space-y-4">
        <p className="text-sm font-bold text-rose-400">
          Access Denied: Admin authorization is restricted to {AUTHORIZED_ADMIN_EMAIL}.
        </p>
        <button
          type="button"
          onClick={() => navigateTo("home")}
          className="theme-btn-primary px-5 py-2.5 rounded-xl font-bold text-xs"
        >
          Return to Home
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-4 md:py-8 space-y-6 pb-24">
      {/* Top Header with Back Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={goBack}
            aria-label="Back"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-white active:scale-95 transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-white">
              Admin Catalog Command
            </h1>
            <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>
                Owner Super Admin ·{" "}
                {isFirebaseAdminAuthenticated
                  ? "Firebase ID Token & Cloud Sync Active"
                  : "Authorized Owner Session"}
              </span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            type="button"
            disabled={isSyncingCloud}
            onClick={handleSyncCatalogToCloud}
            title="Sync local catalog backup to Firebase Cloud"
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-xs font-semibold text-white flex items-center gap-2 transition-colors disabled:opacity-60"
          >
            <ShieldCheck className={`w-4 h-4 text-emerald-400 ${isSyncingCloud ? "animate-pulse" : ""}`} />
            <span className="hidden sm:inline">{isSyncingCloud ? "Syncing..." : "Cloud Sync"}</span>
          </button>

          <button
            type="button"
            onClick={() => loadAdminAnime(false)}
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-white/20 text-xs font-semibold text-white flex items-center gap-2 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          <button
            type="button"
            onClick={openAddModal}
            className="theme-btn-primary min-h-[44px] px-4 py-2 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-2 active:scale-95 transition-transform"
          >
            <Plus className="w-4 h-4" />
            <span>Add Anime</span>
          </button>

          <button
            type="button"
            onClick={logoutAdmin}
            title="Sign Out Admin"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Status Alert Banner */}
      {statusMessage && (
        <div
          className={`p-3.5 rounded-2xl text-xs font-medium flex items-center gap-2.5 transition-colors ${
            statusMessage.isError
              ? "bg-rose-500/15 border border-rose-500/30 text-rose-300"
              : "bg-emerald-500/15 border border-emerald-500/30 text-emerald-300"
          }`}
        >
          {statusMessage.isError ? (
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          ) : (
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* Admin Workspace Tabs */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            sound.playClick();
            setAdminTab("catalog");
          }}
          className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-colors ${
            adminTab === "catalog"
              ? "bg-[var(--primary)] text-white shadow-sm"
              : "bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-white"
          }`}
        >
          <Tv className="w-4 h-4" />
          <span>Catalog ({allAnime.length})</span>
        </button>
        <button
          type="button"
          onClick={() => {
            sound.playClick();
            setAdminTab("insights");
          }}
          className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-colors ${
            adminTab === "insights"
              ? "bg-[var(--primary)] text-white shadow-sm"
              : "bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-white"
          }`}
        >
          <BarChart3 className="w-4 h-4" />
          <span>Stats &amp; Users</span>
        </button>
      </div>

      {adminTab === "insights" ? (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-[var(--primary)]" />
              <span>Platform Statistics &amp; Registered Accounts</span>
            </h2>
            <button
              type="button"
              onClick={loadAdminInsights}
              disabled={isLoadingInsights}
              className="px-3 py-1.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs font-semibold text-white flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingInsights ? "animate-spin" : ""}`} />
              <span>Reload Stats</span>
            </button>
          </div>

          {insightsError && (
            <div className="p-3 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs">
              {insightsError}
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-4 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)]">
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">Total Anime</p>
              <p className="text-2xl font-black text-white mt-1">
                {adminStats?.totalAnime ?? allAnime.length}
              </p>
              <p className="text-[11px] text-emerald-400 mt-0.5">
                {adminStats?.publishedAnime ?? allAnime.filter((a) => a.isPublished).length} Live
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)]">
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">Total Episodes</p>
              <p className="text-2xl font-black text-white mt-1">
                {adminStats?.totalEpisodes ?? "—"}
              </p>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                {adminStats?.publishedEpisodes ?? 0} Live · {adminStats?.draftEpisodes ?? 0} Draft
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)]">
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">Trending &amp; Enriched</p>
              <p className="text-2xl font-black text-white mt-1">
                {adminStats?.trendingAnime ?? allAnime.filter((a) => a.trending).length}
              </p>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                {adminStats?.enrichedCreditsAnime ?? allAnime.filter((a) => Boolean(a.studio || (a.cast && a.cast.length))).length} With Credits
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)]">
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">Registered Users</p>
              <p className="text-2xl font-black text-white mt-1">
                {adminStats?.totalUsers ?? adminUsers.length}
              </p>
              <p className="text-[11px] text-[var(--primary)] mt-0.5">
                Admin: {AUTHORIZED_ADMIN_EMAIL}
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
            <div className="p-4 border-b border-[var(--border-subtle)] flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2">
                <Users className="w-4 h-4 text-[var(--primary)]" />
                <span>Registered Users ({adminUsers.length})</span>
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[var(--bg-surface)] text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                  <tr>
                    <th className="py-3 px-4 font-semibold">User</th>
                    <th className="py-3 px-4 font-semibold">Role</th>
                    <th className="py-3 px-4 font-semibold">Verified</th>
                    <th className="py-3 px-4 font-semibold">Last Active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {adminUsers.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 px-4 text-center text-[var(--text-muted)]">
                        {isLoadingInsights ? "Loading users..." : "No user records returned from server session."}
                      </td>
                    </tr>
                  ) : (
                    adminUsers.map((u) => (
                      <tr key={u.uid} className="hover:bg-[var(--bg-surface)]/40">
                        <td className="py-3 px-4">
                          <p className="font-bold text-white">{u.displayName || "Viewer"}</p>
                          <p className="text-[11px] text-[var(--text-muted)]">{u.email}</p>
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              u.role === "admin"
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                : "bg-white/10 text-neutral-300"
                            }`}
                          >
                            {u.role || "user"}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {u.emailVerified ? "Verified" : "Unverified"}
                        </td>
                        <td className="py-3 px-4 text-[11px] text-[var(--text-muted)]">
                          {u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
      /* Catalog Table */
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden shadow-lg">
        <div className="p-4 border-b border-[var(--border-subtle)] flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
            Total Anime in Database ({allAnime.length})
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            Published: {allAnime.filter((a) => a.isPublished).length} · Drafts:{" "}
            {allAnime.filter((a) => !a.isPublished).length}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[var(--bg-surface)] text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
              <tr>
                <th className="py-3 px-4 font-semibold">Poster</th>
                <th className="py-3 px-4 font-semibold">Title & Japanese</th>
                <th className="py-3 px-4 font-semibold">Rating</th>
                <th className="py-3 px-4 font-semibold">Episodes</th>
                <th className="py-3 px-4 font-semibold">Status</th>
                <th className="py-3 px-4 font-semibold">Published</th>
                <th className="py-3 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {allAnime.map((anime) => (
                <tr key={anime.id} className="hover:bg-[var(--bg-surface)]/50 transition-colors">
                  <td className="py-3 px-4">
                    <div className="w-10 h-14 rounded-lg overflow-hidden bg-neutral-900 border border-white/10 shrink-0 flex items-center justify-center">
                      {anime.posterImage ? (
                        <img
                          src={anime.posterImage}
                          alt={anime.title}
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <Tv className="w-4 h-4 text-neutral-500" />
                      )}
                    </div>
                  </td>

                  <td className="py-3 px-4 max-w-xs">
                    <p className="font-bold text-white truncate">{anime.title}</p>
                    {anime.titleJapanese && (
                      <p className="text-[11px] text-[var(--text-muted)] truncate">
                        {anime.titleJapanese}
                      </p>
                    )}
                    <p className="text-[10px] text-[var(--text-muted)] mt-0.5 truncate">
                      {(Array.isArray(anime.genres) ? anime.genres : []).slice(0, 2).join(", ") || "Anime"} · <span className="font-mono opacity-80">{anime.id}</span>
                    </p>
                  </td>

                  <td className="py-3 px-4">
                    <span className="font-semibold text-white">{formatAgeRatingLabel(anime.rating)}</span>
                  </td>

                  <td className="py-3 px-4 font-mono tabular-nums">
                    {anime.episodesCount}
                  </td>

                  <td className="py-3 px-4">
                    <span className="text-[11px] text-neutral-300">{anime.status}</span>
                  </td>

                  <td className="py-3 px-4">
                    <button
                      type="button"
                      onClick={() => handleTogglePublish(anime)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                        anime.isPublished
                          ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                          : "bg-neutral-800 text-neutral-400 border border-neutral-700"
                      }`}
                    >
                      {anime.isPublished ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                      <span>{anime.isPublished ? "Live" : "Draft"}</span>
                    </button>
                  </td>

                  <td className="py-3 px-4 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openEpisodesManager(anime)}
                        title="Manage Episodes"
                        className="p-1.5 rounded-lg bg-[var(--bg-surface)] hover:bg-white/10 border border-[var(--border-subtle)] text-neutral-300 hover:text-white"
                      >
                        <Layers className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditModal(anime)}
                        title="Edit Anime"
                        className="p-1.5 rounded-lg bg-[var(--bg-surface)] hover:bg-white/10 border border-[var(--border-subtle)] text-neutral-300 hover:text-white"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setAnimeToDelete(anime)}
                        title="Delete Anime"
                        className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-rose-400"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Add / Edit Anime Modal (Mobile-Safe Bounded Container, No Column Shift on Keyboard Open) */}
      {showAddEditModal && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-2 sm:p-4 bg-black/85 backdrop-blur-md overflow-hidden">
          <div className="w-full max-w-2xl max-h-[90dvh] flex flex-col bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-3xl shadow-2xl text-white overflow-hidden mt-2 sm:mt-0">
            {/* Pinned Sticky Modal Header */}
            <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-card)]">
              <h3 className="text-base sm:text-lg font-bold">
                {editingAnime ? "Edit Anime Record" : "Add New Anime"}
              </h3>
              <button
                type="button"
                onClick={() => setShowAddEditModal(false)}
                className="min-h-[36px] px-3 rounded-xl bg-white/5 hover:bg-white/10 text-neutral-300 hover:text-white text-xs font-semibold"
              >
                Close
              </button>
            </div>

            {/* Scrollable Modal Body */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-6 space-y-5">
              {/* In-Modal Feedback Banner (Always Visible!) */}
              {modalFeedback && (
                <div
                  className={`p-3 rounded-2xl text-xs font-medium flex items-center gap-2 ${
                    modalFeedback.isError
                      ? "bg-rose-500/15 border border-rose-500/30 text-rose-300"
                      : "bg-emerald-500/15 border border-emerald-500/30 text-emerald-300"
                  }`}
                >
                  {modalFeedback.isError ? (
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  ) : (
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  )}
                  <span>{modalFeedback.text}</span>
                </div>
              )}

              {/* AniList Search Auto-fill Box */}
              <div className="p-4 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-[var(--primary)]">
                  <Sparkles className="w-4 h-4" />
                  <span>AniList Metadata Auto-Lookup (Optional)</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={aniListQuery}
                    onChange={(e) => setAniListQuery(e.target.value)}
                    placeholder="e.g. Demon Slayer, Solo Leveling..."
                    className="flex-1 min-w-0 h-10 px-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)]"
                  />
                  <button
                    type="button"
                    onClick={handleSearchAniList}
                    disabled={isSearchingAniList}
                    className="shrink-0 px-3.5 sm:px-4 h-10 rounded-xl bg-[var(--primary)] text-white text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-transform"
                  >
                    <Search className="w-3.5 h-3.5" />
                    <span>{isSearchingAniList ? "..." : "Search"}</span>
                  </button>
                </div>

                {/* AniList Results List */}
                {aniListResults.length > 0 && (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pt-2 border-t border-[var(--border-subtle)]">
                    {aniListResults.map((r) => (
                      <div
                        key={r.aniListId}
                        onClick={() => applyAniListResult(r)}
                        className="p-2 rounded-xl bg-[var(--bg-card)] hover:bg-[var(--primary)]/20 border border-[var(--border-subtle)] cursor-pointer flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="flex items-center gap-2.5 truncate">
                          {r.posterImage && (
                            <img
                              src={r.posterImage}
                              alt=""
                              className="w-6 h-8 object-cover rounded"
                            />
                          )}
                          <span className="font-semibold truncate">{r.title}</span>
                          <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                            ({r.year})
                          </span>
                        </div>
                        <span className="text-[10px] text-[var(--primary)] font-bold shrink-0">
                          Apply Data
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Anime Data Form */}
              <form onSubmit={handleSaveAnime} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-neutral-300">English Title</label>
                    <input
                      type="text"
                      required
                      value={formTitle}
                      onChange={(e) => setFormTitle(e.target.value)}
                      placeholder="Enter anime title..."
                      className="w-full h-11 px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--primary)] text-base sm:text-sm text-white focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-neutral-300">Japanese Title</label>
                    <input
                      type="text"
                      value={formJapanese}
                      onChange={(e) => setFormJapanese(e.target.value)}
                      placeholder="Optional Japanese title..."
                      className="w-full h-11 px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--primary)] text-base sm:text-sm text-white focus:outline-none"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-300">Synopsis (Optional)</label>
                  <textarea
                    rows={3}
                    value={formSynopsis}
                    onChange={(e) => setFormSynopsis(e.target.value)}
                    placeholder="Enter anime description (auto-filled if left blank)..."
                    className="w-full p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--primary)] text-base sm:text-sm text-white focus:outline-none resize-none"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Poster upload from Gallery or URL */}
                  <div className="space-y-2 p-3 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-semibold text-neutral-300">Poster Image</label>
                      <label className="px-2.5 py-1 rounded-lg bg-[var(--primary)]/15 border border-[var(--primary)]/30 text-[11px] font-bold text-[var(--primary)] cursor-pointer flex items-center gap-1 hover:bg-[var(--primary)]/25">
                        <Upload className="w-3 h-3" />
                        <span>{uploadingTarget === "poster" ? "Uploading..." : "Gallery / File"}</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => handleFileUpload(e, "poster")}
                        />
                      </label>
                    </div>
                    <div className="flex items-center gap-2.5">
                      {formPoster && (
                        <div className="w-11 h-14 rounded-lg overflow-hidden border border-white/15 bg-black shrink-0">
                          <img
                            src={formPoster}
                            alt="Poster preview"
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        </div>
                      )}
                      <input
                        type="text"
                        value={formPoster}
                        onChange={(e) => setFormPoster(e.target.value)}
                        placeholder="Select gallery photo or paste URL"
                        className="flex-1 min-w-0 h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Banner upload from Gallery or URL */}
                  <div className="space-y-2 p-3 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-semibold text-neutral-300">Banner Image (Optional)</label>
                      <label className="px-2.5 py-1 rounded-lg bg-white/10 border border-white/15 text-[11px] font-semibold text-neutral-200 cursor-pointer flex items-center gap-1 hover:bg-white/20">
                        <Upload className="w-3 h-3" />
                        <span>{uploadingTarget === "banner" ? "Uploading..." : "Gallery / File"}</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => handleFileUpload(e, "banner")}
                        />
                      </label>
                    </div>
                    <div className="flex items-center gap-2.5">
                      {formBanner && (
                        <div className="w-16 h-11 rounded-lg overflow-hidden border border-white/15 bg-black shrink-0">
                          <img
                            src={formBanner}
                            alt="Banner preview"
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        </div>
                      )}
                      <input
                        type="text"
                        value={formBanner}
                        onChange={(e) => setFormBanner(e.target.value)}
                        placeholder="Optional banner URL or gallery"
                        className="flex-1 min-w-0 h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white focus:outline-none"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div className="space-y-1 col-span-2 sm:col-span-2">
                    <label className="text-[11px] font-semibold text-neutral-300">Age Rating (Required)</label>
                    <select
                      aria-label="Age Rating"
                      value={formRatingSelect}
                      onChange={(e) => {
                        setFormRatingSelect(e.target.value);
                        setFormRatingConfirmed(false);
                      }}
                      className="w-full h-10 px-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-base sm:text-xs text-white focus:outline-none focus:border-[var(--primary)]"
                    >
                      <option value="">Select Age Rating...</option>
                      {AGE_RATING_PRESETS.map((r) => (
                        <option key={r} value={r}>
                          {formatAgeRatingLabel(r)}
                        </option>
                      ))}
                      <option value="Custom">Custom Age Rating...</option>
                    </select>
                  </div>

                  {formRatingSelect === "Custom" && (
                    <div className="space-y-1 col-span-2 sm:col-span-3">
                      <label className="text-[11px] font-semibold text-neutral-300">Custom Age Rating</label>
                      <input
                        type="text"
                        maxLength={32}
                        value={formCustomRating}
                        onChange={(e) => {
                          setFormCustomRating(e.target.value);
                          setFormRatingConfirmed(false);
                        }}
                        placeholder="e.g. 15+, TV-14, PG"
                        className="w-full h-10 px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--primary)] text-base sm:text-xs text-white focus:outline-none"
                      />
                    </div>
                  )}

                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-neutral-300">Status</label>
                    <select
                      aria-label="Status"
                      value={formStatus}
                      onChange={(e) => setFormStatus(e.target.value as any)}
                      className="w-full h-10 px-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-base sm:text-xs text-white focus:outline-none"
                    >
                      <option value="Ongoing">Ongoing</option>
                      <option value="Completed">Completed</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-neutral-300">Year</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label="Release Year"
                      value={formYearInput}
                      onChange={(e) => setFormYearInput(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder="2025"
                      className="w-full h-10 px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-base sm:text-xs text-white focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-neutral-300">Seasons</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label="Seasons Count"
                      value={formSeasonsInput}
                      onChange={(e) => setFormSeasonsInput(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder="1"
                      className="w-full h-10 px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-base sm:text-xs text-white focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1 col-span-2 sm:col-span-2">
                    <label className="text-[11px] font-semibold text-neutral-300">
                      Episodes <span className="text-[10px] text-[var(--text-muted)]">(0, 1, 24, 100+)</span>
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label="Episodes Count"
                      value={formEpisodesInput}
                      onChange={(e) => setFormEpisodesInput(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder="0, 1, 24, 100..."
                      className="w-full h-10 px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--primary)] text-base sm:text-xs text-white focus:outline-none"
                    />
                  </div>
                </div>

                {/* Explicit Admin Confirmation for Age Rating */}
                <div className="flex items-center gap-2.5 p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                  <input
                    type="checkbox"
                    id="rating-confirm-check"
                    checked={formRatingConfirmed}
                    onChange={(e) => setFormRatingConfirmed(e.target.checked)}
                    className="w-4 h-4 rounded text-[var(--primary)] focus:ring-0"
                  />
                  <ShieldCheck className="w-4 h-4 text-[var(--primary)] shrink-0" />
                  <label htmlFor="rating-confirm-check" className="text-xs font-semibold text-neutral-200 cursor-pointer">
                    I confirm this Age Rating classification ({formRatingSelect === "Custom" ? formCustomRating.trim() || "Custom" : formRatingSelect || "Not selected"}) is accurate for viewing restrictions
                  </label>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-300">Genres (comma separated)</label>
                  <input
                    type="text"
                    value={formGenres}
                    onChange={(e) => setFormGenres(e.target.value)}
                    placeholder="Action, Cyberpunk, Sci-Fi"
                    className="w-full h-10 px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-base sm:text-xs text-white focus:outline-none"
                  />
                </div>

                {/* Multi-Quality Video Uploader (360p up to 2160p 4K — Saved inside this single anime card) */}
                <div className="space-y-3 p-3.5 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Film className="w-4 h-4 text-[var(--primary)]" />
                      <label className="text-[11px] font-bold text-white">
                        Anime / Movie Videos by Quality (360p – 4K)
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowAllAnimeQualities((prev) => !prev)}
                      className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-neutral-200"
                    >
                      {showAllAnimeQualities ? "Hide 4K / 2K / 360p" : "Show 4K / 2K / 360p Slots"}
                    </button>
                  </div>

                  {/* Live Video Upload Progress Bar */}
                  {animeVideoProgress && (isUploadingAnimeVideo || animeVideoProgress.state === "success" || animeVideoProgress.state === "error") && (
                    <div className={`p-2.5 rounded-xl border space-y-1.5 ${
                      animeVideoProgress.state === "error"
                        ? "bg-rose-950/40 border-rose-500/40"
                        : "bg-black/40 border-white/10"
                    }`}>
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate font-semibold text-neutral-200">
                          {animeUploadQualityTarget ? `[${animeUploadQualityTarget}] ` : ""}
                          {animeVideoFileName || "Selected video"}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`font-mono font-bold ${
                            animeVideoProgress.state === "error" ? "text-rose-400" : "text-[var(--primary)]"
                          }`}>
                            {animeVideoProgress.percent}%
                          </span>
                          <span className="text-[10px] text-neutral-400">
                            ({formatBytes(animeVideoProgress.bytesTransferred)} / {formatBytes(animeVideoProgress.totalBytes)})
                          </span>
                          {isUploadingAnimeVideo && (
                            <button
                              type="button"
                              onClick={() => animeVideoTaskRef.current?.cancel()}
                              className="p-0.5 rounded bg-rose-500/20 text-rose-400 hover:bg-rose-500/30"
                              title="Cancel Upload"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-200 ${
                            animeVideoProgress.state === "error" ? "bg-rose-500" : "bg-[var(--primary)]"
                          }`}
                          style={{ width: `${animeVideoProgress.percent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Inline Upload Feedback Banner */}
                  {animeVideoFeedback && (
                    <div
                      className={`p-2.5 rounded-xl text-[11px] font-medium flex items-center gap-2 ${
                        animeVideoFeedback.isError
                          ? "bg-rose-500/15 border border-rose-500/35 text-rose-300"
                          : "bg-emerald-500/15 border border-emerald-500/35 text-emerald-300"
                      }`}
                    >
                      {animeVideoFeedback.isError ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      ) : (
                        <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      )}
                      <span>{animeVideoFeedback.text}</span>
                    </div>
                  )}

                  {/* 1080p Full HD Primary Slot */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[10px] font-semibold text-neutral-300">
                        1080p Full HD (MP4 / M3U8 / YouTube URL or Gallery)
                      </label>
                      <label className={`px-2.5 py-1 rounded-lg bg-[var(--primary)]/15 border border-[var(--primary)]/40 text-[11px] font-bold text-[var(--primary)] cursor-pointer flex items-center gap-1.5 hover:bg-[var(--primary)]/25 active:scale-95 transition-all ${isUploadingAnimeVideo ? "opacity-50 pointer-events-none" : ""}`}>
                        <Upload className="w-3 h-3" />
                        <span>
                          {isUploadingAnimeVideo && animeUploadQualityTarget === "1080p"
                            ? `${animeVideoProgress?.percent ?? 0}%`
                            : "Pick 1080p Video"}
                        </span>
                        <input
                          type="file"
                          accept="video/*,video/mp4,video/webm,video/quicktime,.mkv"
                          className="hidden"
                          disabled={isUploadingAnimeVideo}
                          onChange={(e) => handleAnimeVideoUpload(e, "1080p")}
                        />
                      </label>
                    </div>
                    <input
                      type="text"
                      value={formQualityUrls["1080p"]}
                      onChange={(e) =>
                        setFormQualityUrls((prev) => ({ ...prev, "1080p": e.target.value }))
                      }
                      placeholder="Pick 1080p video from gallery or paste MP4 / M3U8 / YouTube URL..."
                      className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white focus:outline-none"
                    />
                  </div>

                  {/* Additional Quality Slots (720p, 480p, plus 2160p/1440p/360p when expanded) */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {VIDEO_QUALITIES.filter((q) => {
                      if (q === "1080p") return false;
                      if (q === "720p" || q === "480p") return true;
                      return showAllAnimeQualities || Boolean(formQualityUrls[q]);
                    }).map((qCode) => (
                      <div key={qCode} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-[10px] font-semibold text-neutral-300">
                            {VIDEO_QUALITY_META[qCode].fullLabel} (Optional)
                          </label>
                          <label className={`px-2 py-1 rounded-lg bg-white/10 border border-white/15 text-[10px] font-bold text-neutral-200 cursor-pointer flex items-center gap-1 hover:bg-white/20 ${isUploadingAnimeVideo ? "opacity-50 pointer-events-none" : ""}`}>
                            <Upload className="w-3 h-3" />
                            <span>
                              {isUploadingAnimeVideo && animeUploadQualityTarget === qCode
                                ? `${animeVideoProgress?.percent ?? 0}%`
                                : `Pick ${qCode}`}
                            </span>
                            <input
                              type="file"
                              accept="video/*,video/mp4,video/webm,video/quicktime,.mkv"
                              className="hidden"
                              disabled={isUploadingAnimeVideo}
                              onChange={(e) => handleAnimeVideoUpload(e, qCode)}
                            />
                          </label>
                        </div>
                        <input
                          type="text"
                          value={formQualityUrls[qCode]}
                          onChange={(e) =>
                            setFormQualityUrls((prev) => ({ ...prev, [qCode]: e.target.value }))
                          }
                          placeholder={`Pick ${qCode} gallery video or paste URL`}
                          className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white focus:outline-none"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Production Credits & Cast (Per-Anime Authentic Metadata) */}
                <div className="space-y-3 p-3.5 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-[var(--primary)]" />
                      <span className="text-[11px] font-bold text-white">
                        Studio, Author, Director &amp; Voice Cast
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={handleEnrichCreditsOnly}
                      disabled={isFetchingCredits}
                      className="px-2.5 py-1 rounded-lg bg-[var(--primary)]/15 border border-[var(--primary)]/35 text-[10px] font-bold text-[var(--primary)] flex items-center gap-1 hover:bg-[var(--primary)]/25 disabled:opacity-50"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>{isFetchingCredits ? "Fetching..." : "Auto-Enrich from AniList"}</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-300">Animation Studio</label>
                      <input
                        type="text"
                        value={formStudio}
                        onChange={(e) => setFormStudio(e.target.value)}
                        placeholder="e.g. ufotable, MAPPA, Studio Pierrot..."
                        className="w-full h-9 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-300">Author / Original Creator</label>
                      <input
                        type="text"
                        value={formAuthor}
                        onChange={(e) => setFormAuthor(e.target.value)}
                        placeholder="e.g. Koyoharu Gotouge..."
                        className="w-full h-9 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-300">Director</label>
                      <input
                        type="text"
                        value={formDirector}
                        onChange={(e) => setFormDirector(e.target.value)}
                        placeholder="e.g. Haruo Sotozaki..."
                        className="w-full h-9 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-300">Production Company</label>
                      <input
                        type="text"
                        value={formProductionCompany}
                        onChange={(e) => setFormProductionCompany(e.target.value)}
                        placeholder="e.g. Aniplex, Shueisha..."
                        className="w-full h-9 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Per-Anime Cast & Voice Actors Editor */}
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-neutral-300 flex items-center gap-1.5">
                        <Users className="w-3.5 h-3.5 text-[var(--primary)]" />
                        <span>Characters &amp; Voice Actors ({formCast.length})</span>
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setFormCast((prev) => [
                            ...prev,
                            { characterName: "", voiceActor: "", language: "Japanese", role: "Main" },
                          ])
                        }
                        className="px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-[10px] font-bold text-white flex items-center gap-1"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Add Cast Member</span>
                      </button>
                    </div>

                    {formCast.length > 0 && (
                      <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                        {formCast.map((member, idx) => (
                          <div key={idx} className="grid grid-cols-12 gap-1.5 items-center">
                            <input
                              type="text"
                              value={member.characterName}
                              onChange={(e) =>
                                setFormCast((prev) =>
                                  prev.map((m, i) => (i === idx ? { ...m, characterName: e.target.value } : m))
                                )
                              }
                              placeholder="Character"
                              className="col-span-4 h-8 px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[11px] text-white"
                            />
                            <input
                              type="text"
                              value={member.voiceActor}
                              onChange={(e) =>
                                setFormCast((prev) =>
                                  prev.map((m, i) => (i === idx ? { ...m, voiceActor: e.target.value } : m))
                                )
                              }
                              placeholder="Voice Actor"
                              className="col-span-4 h-8 px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[11px] text-white"
                            />
                            <input
                              type="text"
                              value={member.language || ""}
                              onChange={(e) =>
                                setFormCast((prev) =>
                                  prev.map((m, i) => (i === idx ? { ...m, language: e.target.value } : m))
                                )
                              }
                              placeholder="Lang"
                              className="col-span-3 h-8 px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[11px] text-white"
                            />
                            <button
                              type="button"
                              onClick={() => setFormCast((prev) => prev.filter((_, i) => i !== idx))}
                              title="Remove cast member"
                              className="col-span-1 h-8 flex items-center justify-center rounded-lg text-rose-400 hover:bg-rose-500/15"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Published & Trending Switches */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                    <input
                      type="checkbox"
                      id="pub-check"
                      checked={formIsPublished}
                      onChange={(e) => setFormIsPublished(e.target.checked)}
                      className="w-4 h-4 rounded text-[var(--primary)] focus:ring-0"
                    />
                    <label htmlFor="pub-check" className="text-xs font-semibold cursor-pointer">
                      Publish to Public Catalog immediately
                    </label>
                  </div>

                  <div className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                    <input
                      type="checkbox"
                      id="trending-check"
                      checked={formTrending}
                      onChange={(e) => setFormTrending(e.target.checked)}
                      className="w-4 h-4 rounded text-[var(--primary)] focus:ring-0"
                    />
                    <TrendingUp className="w-4 h-4 text-[var(--primary)] shrink-0" />
                    <label htmlFor="trending-check" className="text-xs font-semibold cursor-pointer">
                      Feature in Trending Anime shelf
                    </label>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 pt-2 pb-1">
                  <button
                    type="button"
                    onClick={() => setShowAddEditModal(false)}
                    className="px-4 py-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isUploadingFile || isUploadingAnimeVideo}
                    className="theme-btn-primary px-6 py-2.5 rounded-xl text-xs font-bold disabled:opacity-60"
                  >
                    {isUploadingAnimeVideo
                      ? `Uploading Video ${animeVideoProgress?.percent ?? 0}%...`
                      : isUploadingFile
                      ? "Uploading Image..."
                      : "Save Anime Record"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {animeToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-md bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-3xl p-6 shadow-2xl space-y-4 text-white">
            <div className="flex items-center gap-3 text-rose-500">
              <AlertTriangle className="w-6 h-6" />
              <h3 className="text-base font-bold text-white">Confirm Anime Deletion</h3>
            </div>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Are you sure you want to delete <span className="font-bold text-white">"{animeToDelete.title}"</span>? This will permanently remove its catalog entry, all associated episodes, and records from the persistent database.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setAnimeToDelete(null)}
                className="px-4 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteAnime}
                className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition-colors"
              >
                Delete Anime
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Episode Manager Sheet (Full Multi-Episode CRUD, Bulk Add 1-100, Reorder, Filter, Search, Preview) */}
      {managingAnimeEpisodes && (() => {
        const epSeasonsAvailable = Array.from(
          new Set(episodesList.map((ep) => ep.season || 1))
        ).sort((a, b) => a - b);

        const epLanguagesAvailable = Array.from(
          new Set([
            ...EPISODE_LANGUAGES,
            ...episodesList.map((ep) => String(ep.language || "Japanese").trim()).filter(Boolean),
          ])
        );

        const q = epSearchQuery.trim().toLowerCase();
        const filteredManageEpisodes = episodesList.filter((ep) => {
          const seasonOk = epSeasonFilter === "ALL" || (ep.season || 1) === epSeasonFilter;
          const langOk =
            epLanguageFilter === "ALL" || (ep.language || "Japanese") === epLanguageFilter;
          const desc = (ep.description ?? ep.synopsis ?? "").toLowerCase();
          const langLower = String(ep.language || "").toLowerCase();
          const queryOk =
            !q ||
            ep.title.toLowerCase().includes(q) ||
            desc.includes(q) ||
            langLower.includes(q) ||
            String(ep.number).includes(q) ||
            `e${ep.number}`.includes(q) ||
            `s${ep.season || 1}`.includes(q);
          return seasonOk && langOk && queryOk;
        });

        const sortedFilteredManageEpisodes = [...filteredManageEpisodes].sort((a, b) => {
          if (epSortBy === "number-asc") {
            return (a.season || 1) - (b.season || 1) || a.number - b.number;
          }
          if (epSortBy === "number-desc") {
            return (b.season || 1) - (a.season || 1) || b.number - a.number;
          }
          if (epSortBy === "season-asc") {
            return (a.season || 1) - (b.season || 1) || (a.order ?? a.number) - (b.order ?? b.number);
          }
          if (epSortBy === "updated-desc") {
            const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
            const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
            return tb - ta;
          }
          return (a.season || 1) - (b.season || 1) || (a.order ?? a.number) - (b.order ?? b.number) || a.number - b.number;
        });

        const parsedBulkStartNum = Math.max(1, parseInt(bulkStartEpInput, 10) || 1);
        const parsedBulkEndNum = Math.max(
          parsedBulkStartNum,
          parseInt(bulkEndEpInput, 10) || parsedBulkStartNum
        );

        return (
          <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-2 sm:p-4 bg-black/85 backdrop-blur-md overflow-hidden">
            <div className="w-full max-w-3xl max-h-[92dvh] flex flex-col bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-3xl shadow-2xl text-white overflow-hidden mt-1 sm:mt-0">
              {/* Pinned Modal Header */}
              <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-card)]">
                <div className="min-w-0">
                  <h3 className="text-base font-bold flex items-center gap-2">
                    <span>Manage Episodes</span>
                    <span className="px-2 py-0.5 rounded-md bg-[var(--primary)]/20 text-[var(--primary)] text-[11px] font-bold">
                      {episodesList.length} Saved
                    </span>
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] truncate">
                    {managingAnimeEpisodes.title} · <span className="font-mono text-[10px]">ID: {managingAnimeEpisodes.id}</span>
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleStartAddNewEpisode}
                    className={`min-h-[36px] px-3 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all ${
                      epManagerMode === "single" && !editingEpisodeId
                        ? "bg-[var(--primary)] text-white shadow-sm"
                        : "bg-white/10 hover:bg-white/15 text-white"
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add New Episode</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      sound.playClick();
                      setEpModalFeedback(null);
                      setEpManagerMode((m) => (m === "bulk" ? "single" : "bulk"));
                      if (bulkRows.length === 0) {
                        setBulkRows(
                          buildBulkRows(
                            parsedBulkStartNum,
                            parsedBulkEndNum,
                            bulkPasteUrls,
                            bulkTitlePattern,
                            bulkSharedThumb,
                            bulkSharedDesc,
                            bulkAllowSharedUrl,
                            bulkSharedSingleUrl
                          )
                        );
                      }
                    }}
                    className={`min-h-[36px] px-3 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all ${
                      epManagerMode === "bulk"
                        ? "bg-[var(--primary)] text-white shadow-sm"
                        : "bg-white/10 hover:bg-white/15 text-neutral-200"
                    }`}
                  >
                    <ListPlus className="w-3.5 h-3.5" />
                    <span>Bulk Add (1–100)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setManagingAnimeEpisodes(null)}
                    className="min-h-[36px] px-3 rounded-xl bg-white/5 hover:bg-white/10 text-neutral-300 hover:text-white text-xs font-semibold"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-6 space-y-5">
                {epModalFeedback && (
                  <div
                    className={`p-3 rounded-2xl text-xs font-medium flex items-center gap-2 ${
                      epModalFeedback.isError
                        ? "bg-rose-500/15 border border-rose-500/30 text-rose-300"
                        : "bg-emerald-500/15 border border-emerald-500/30 text-emerald-300"
                    }`}
                  >
                    {epModalFeedback.isError ? (
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    ) : (
                      <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    )}
                    <span>{epModalFeedback.text}</span>
                  </div>
                )}

                {epManagerMode === "bulk" ? (
                  /* BULK ADD EPISODES FORM (1 to 100 episodes attached to same animeId) */
                  <form
                    onSubmit={handleSaveBulkEpisodes}
                    className="p-4 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] space-y-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-xs font-bold text-white flex items-center gap-2">
                        <ListPlus className="w-4 h-4 text-[var(--primary)]" />
                        <span>Bulk Add Episodes into {managingAnimeEpisodes.title}</span>
                      </h4>
                      <span className="text-[10px] text-neutral-400">
                        Individual video URLs per episode required unless explicitly opted in below
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5 items-end">
                      <div>
                        <label className="text-[10px] text-neutral-400">Season No.</label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={bulkSeasonInput}
                          onChange={(e) => setBulkSeasonInput(e.target.value.replace(/[^\d]/g, ""))}
                          placeholder="1"
                          className="w-full h-9 px-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white"
                        />
                      </div>
                      <div className="col-span-1 sm:col-span-2">
                        <label className="text-[10px] text-neutral-400">Audio Language</label>
                        <select
                          aria-label="Bulk Audio Language"
                          value={bulkLanguagePreset}
                          onChange={(e) => setBulkLanguagePreset(e.target.value)}
                          className="w-full h-9 px-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white"
                        >
                          {EPISODE_LANGUAGES.map((lang) => (
                            <option key={lang} value={lang}>
                              {lang}
                            </option>
                          ))}
                          <option value="Other">Other Language...</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] text-neutral-400">Start Ep</label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={bulkStartEpInput}
                          onChange={(e) => setBulkStartEpInput(e.target.value.replace(/[^\d]/g, ""))}
                          placeholder="1"
                          className="w-full h-9 px-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-neutral-400">End Ep</label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={bulkEndEpInput}
                          onChange={(e) => setBulkEndEpInput(e.target.value.replace(/[^\d]/g, ""))}
                          placeholder="12"
                          className="w-full h-9 px-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          sound.playClick();
                          setBulkRows(
                            buildBulkRows(
                              parsedBulkStartNum,
                              parsedBulkEndNum,
                              bulkPasteUrls,
                              bulkTitlePattern,
                              bulkSharedThumb,
                              bulkSharedDesc,
                              bulkAllowSharedUrl,
                              bulkSharedSingleUrl
                            )
                          );
                        }}
                        className="h-9 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold text-white"
                      >
                        Generate Rows
                      </button>
                    </div>

                    {bulkLanguagePreset === "Other" && (
                      <div>
                        <label className="text-[10px] text-neutral-400">Custom Language Name</label>
                        <input
                          type="text"
                          maxLength={40}
                          value={bulkCustomLanguage}
                          onChange={(e) => setBulkCustomLanguage(e.target.value)}
                          placeholder="e.g. Korean, Spanish, French"
                          className="w-full h-9 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white mt-1"
                        />
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <div>
                        <label className="text-[10px] text-neutral-400">Title Pattern (use &#123;n&#125; for Ep No.)</label>
                        <input
                          type="text"
                          value={bulkTitlePattern}
                          onChange={(e) => setBulkTitlePattern(e.target.value)}
                          placeholder="Episode {n}"
                          className="w-full h-9 px-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-neutral-400">Shared Thumbnail URL (Optional)</label>
                        <input
                          type="text"
                          value={bulkSharedThumb}
                          onChange={(e) => setBulkSharedThumb(e.target.value)}
                          placeholder="Optional thumbnail URL..."
                          className="w-full h-9 px-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-neutral-400">Shared Description (Optional)</label>
                        <input
                          type="text"
                          value={bulkSharedDesc}
                          onChange={(e) => setBulkSharedDesc(e.target.value)}
                          placeholder="Optional episode notes..."
                          className="w-full h-9 px-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white"
                        />
                      </div>
                    </div>

                    {/* Explicit opt-in if admin intentionally wants one shared URL across generated rows */}
                    <div className="p-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2">
                      <label className="flex items-center gap-2 text-[11px] font-semibold text-neutral-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={bulkAllowSharedUrl}
                          onChange={(e) => setBulkAllowSharedUrl(e.target.checked)}
                          className="w-3.5 h-3.5 rounded text-[var(--primary)]"
                        />
                        <span>Apply one shared video URL to all generated rows (off by default — leave unchecked for distinct per-episode URLs)</span>
                      </label>
                      {bulkAllowSharedUrl && (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={bulkSharedSingleUrl}
                            onChange={(e) => setBulkSharedSingleUrl(e.target.value)}
                            placeholder="Paste shared Bunny HLS (.m3u8), MP4, or YouTube URL..."
                            className="flex-1 h-8 px-2.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-white"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (!bulkSharedSingleUrl.trim()) return;
                              setBulkRows((prev) =>
                                prev.map((r) => ({ ...r, videoUrl: bulkSharedSingleUrl.trim() }))
                              );
                              sound.playClick();
                            }}
                            className="px-2.5 h-8 rounded-lg bg-[var(--primary)]/20 border border-[var(--primary)]/40 text-[10px] font-bold text-[var(--primary)]"
                          >
                            Fill All Rows
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Quick Paste Multi-Line URLs helper */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-[10px] text-neutral-300 font-semibold">
                          Quick Paste Individual URLs (1 URL per line for Ep {parsedBulkStartNum}..{parsedBulkEndNum})
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            const lines = bulkPasteUrls
                              .split(/\r?\n/)
                              .map((l) => l.trim())
                              .filter(Boolean);
                            setBulkRows((prev) =>
                              prev.map((row, idx) => ({
                                ...row,
                                videoUrl: lines[idx] || row.videoUrl,
                              }))
                            );
                            sound.playClick();
                          }}
                          className="px-2.5 py-1 rounded-lg bg-[var(--primary)]/15 border border-[var(--primary)]/40 text-[10px] font-bold text-[var(--primary)]"
                        >
                          Apply URLs to Rows
                        </button>
                      </div>
                      <textarea
                        rows={3}
                        value={bulkPasteUrls}
                        onChange={(e) => setBulkPasteUrls(e.target.value)}
                        placeholder={"https://vz-xxxx.b-cdn.net/VIDEO_ID/playlist.m3u8\nhttps://youtu.be/VIDEO_ID\nhttps://cdn.example.com/ep3.mp4"}
                        className="w-full p-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white focus:outline-none resize-none"
                      />
                    </div>

                    {/* Editable Individual Episode Rows */}
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {bulkRows.map((row, idx) => {
                        const rowKind = row.videoUrl.trim()
                          ? classifyStreamUrl(row.videoUrl).kind
                          : "empty";
                        return (
                          <div
                            key={row.key}
                            className="p-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-2"
                          >
                            <div className="grid grid-cols-12 gap-2 items-center">
                              <div className="col-span-3 sm:col-span-2">
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={String(row.number)}
                                  onChange={(e) => {
                                    const raw = e.target.value.replace(/[^\d]/g, "");
                                    const val = raw ? parseInt(raw, 10) : 1;
                                    setBulkRows((prev) =>
                                      prev.map((r, i) => (i === idx ? { ...r, number: val } : r))
                                    );
                                  }}
                                  aria-label={`Row ${idx + 1} Episode Number`}
                                  className="w-full h-8 px-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-white"
                                />
                              </div>
                              <div className="col-span-8 sm:col-span-4">
                                <input
                                  type="text"
                                  value={row.title}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setBulkRows((prev) =>
                                      prev.map((r, i) => (i === idx ? { ...r, title: val } : r))
                                    );
                                  }}
                                  placeholder={`Episode ${row.number} title`}
                                  className="w-full h-8 px-2.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-white"
                                />
                              </div>
                              <div className="col-span-10 sm:col-span-5 flex items-center gap-1.5">
                                <input
                                  type="text"
                                  value={row.videoUrl}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setBulkRows((prev) =>
                                      prev.map((r, i) => (i === idx ? { ...r, videoUrl: val } : r))
                                    );
                                  }}
                                  placeholder="Authorized MP4 / M3U8 / YouTube URL"
                                  className="flex-1 min-w-0 h-8 px-2.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-white"
                                />
                                <span
                                  className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                                    rowKind === "empty"
                                      ? "bg-white/5 text-neutral-500"
                                      : rowKind === "invalid"
                                      ? "bg-rose-500/20 text-rose-300"
                                      : "bg-emerald-500/20 text-emerald-300"
                                  }`}
                                >
                                  {rowKind === "empty" ? "Req" : rowKind}
                                </span>
                              </div>
                              <div className="col-span-2 sm:col-span-1 flex justify-end">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setBulkRows((prev) => prev.filter((_, i) => i !== idx))
                                  }
                                  title="Remove row"
                                  className="p-1 text-rose-400 hover:bg-rose-500/10 rounded"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          const nextNum =
                            bulkRows.reduce((m, r) => Math.max(m, r.number), 0) + 1;
                          if (bulkRows.length >= 100) return;
                          setBulkRows((prev) => [
                            ...prev,
                            {
                              key: `bulk-${nextNum}-${Date.now()}`,
                              number: nextNum,
                              title: `Episode ${nextNum}`,
                              videoUrl:
                                bulkAllowSharedUrl && bulkSharedSingleUrl.trim()
                                  ? bulkSharedSingleUrl.trim()
                                  : "",
                              thumbnailUrl: bulkSharedThumb.trim(),
                              description: bulkSharedDesc.trim(),
                            },
                          ]);
                        }}
                        className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold text-white flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Row</span>
                      </button>

                      <button
                        type="submit"
                        disabled={isSavingBulk || bulkRows.length === 0}
                        className="theme-btn-primary px-5 py-2 rounded-xl text-xs font-bold disabled:opacity-60"
                      >
                        {isSavingBulk
                          ? `Saving ${bulkRows.length} Episodes...`
                          : `Save All ${bulkRows.length} Episodes`}
                      </button>
                    </div>
                  </form>
                ) : (
                  /* SINGLE EPISODE ADD / EDIT FORM (All 6 Qualities + Custom Language + Honest 1080p AI Check) */
                  <form
                    ref={epFormRef}
                    onSubmit={handleSaveEpisode}
                    className="p-4 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-bold text-white flex items-center gap-2">
                        {editingEpisodeId ? (
                          <>
                            <Edit className="w-3.5 h-3.5 text-amber-400" />
                            <span>Editing Episode (S{newEpSeasonInput || 1} · E{newEpNumberInput || 1})</span>
                          </>
                        ) : (
                          <>
                            <Plus className="w-3.5 h-3.5 text-[var(--primary)]" />
                            <span>Add New Episode to {managingAnimeEpisodes.title}</span>
                          </>
                        )}
                      </h4>
                      {editingEpisodeId && (
                        <button
                          type="button"
                          onClick={handleStartAddNewEpisode}
                          className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-semibold text-neutral-200"
                        >
                          Cancel Edit
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                      <div>
                        <label className="text-[10px] text-neutral-400">Season</label>
                        <input
                          type="text"
                          inputMode="numeric"
                          aria-label="Episode Season"
                          value={newEpSeasonInput}
                          onChange={(e) => setNewEpSeasonInput(e.target.value.replace(/[^\d]/g, ""))}
                          placeholder="1"
                          className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-neutral-400">Ep No.</label>
                        <input
                          type="text"
                          inputMode="numeric"
                          aria-label="Episode Number"
                          value={newEpNumberInput}
                          onChange={(e) => setNewEpNumberInput(e.target.value.replace(/[^\d]/g, ""))}
                          placeholder="1"
                          className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-neutral-400">Audio Language</label>
                        <select
                          aria-label="Audio Language"
                          value={newEpLanguagePreset}
                          onChange={(e) => setNewEpLanguagePreset(e.target.value)}
                          className="w-full h-10 px-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white"
                        >
                          {EPISODE_LANGUAGES.map((lang) => (
                            <option key={lang} value={lang}>
                              {lang}
                            </option>
                          ))}
                          <option value="Other">Other Language...</option>
                        </select>
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-neutral-400">Episode Title</label>
                        <input
                          type="text"
                          value={newEpTitle}
                          onChange={(e) => setNewEpTitle(e.target.value)}
                          placeholder="Episode title..."
                          className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white"
                        />
                      </div>
                    </div>

                    {newEpLanguagePreset === "Other" && (
                      <div>
                        <label className="text-[10px] text-neutral-400">Custom Language Name</label>
                        <input
                          type="text"
                          maxLength={40}
                          value={newEpCustomLanguage}
                          onChange={(e) => setNewEpCustomLanguage(e.target.value)}
                          placeholder="e.g. Korean, Spanish, Indonesian"
                          className="w-full h-9 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-xs text-white mt-1"
                        />
                      </div>
                    )}

                    {/* Primary Stream Slot (Bunny HLS .m3u8 / 1080p MP4 / YouTube) */}
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="text-[10px] text-neutral-300 font-semibold">
                          Primary Stream URL (Bunny HLS .m3u8 / MP4 / YouTube or Gallery)
                        </label>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setShowAllEpQualities((prev) => !prev)}
                            className="px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-[10px] font-bold text-neutral-200"
                          >
                            {showAllEpQualities ? "Hide 4K / 2K / 360p" : "4K / 2K / 360p Slots"}
                          </button>
                          <label className={`px-2.5 py-1 rounded-lg bg-[var(--primary)]/15 border border-[var(--primary)]/40 text-[11px] font-bold text-[var(--primary)] cursor-pointer flex items-center gap-1.5 hover:bg-[var(--primary)]/25 ${isUploadingVideo ? "opacity-50 pointer-events-none" : ""}`}>
                            <Upload className="w-3 h-3" />
                            <span>
                              {isUploadingVideo && epUploadQualityTarget === "1080p"
                                ? `${epVideoProgress?.percent ?? 0}%`
                                : "Pick 1080p Video"}
                            </span>
                            <input
                              type="file"
                              accept="video/*,video/mp4,video/webm,video/quicktime,.mkv"
                              className="hidden"
                              disabled={isUploadingVideo}
                              onChange={(e) => handleVideoUpload(e, "1080p")}
                            />
                          </label>
                        </div>
                      </div>

                      {epVideoProgress && (isUploadingVideo || epVideoProgress.state === "success" || epVideoProgress.state === "error") && (
                        <div className={`p-2.5 rounded-xl border space-y-1.5 ${
                          epVideoProgress.state === "error"
                            ? "bg-rose-950/40 border-rose-500/40"
                            : "bg-black/40 border-white/10"
                        }`}>
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate font-semibold text-neutral-200">
                              {epUploadQualityTarget ? `[${epUploadQualityTarget}] ` : ""}
                              {epVideoFileName || "Selected episode video"}
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className={`font-mono font-bold ${
                                epVideoProgress.state === "error" ? "text-rose-400" : "text-[var(--primary)]"
                              }`}>
                                {epVideoProgress.percent}%
                              </span>
                              <span className="text-[10px] text-neutral-400">
                                ({formatBytes(epVideoProgress.bytesTransferred)} / {formatBytes(epVideoProgress.totalBytes)})
                              </span>
                              {isUploadingVideo && (
                                <button
                                  type="button"
                                  onClick={() => epUploadTaskRef.current?.cancel()}
                                  className="p-0.5 rounded bg-rose-500/20 text-rose-400 hover:bg-rose-500/30"
                                  title="Cancel Upload"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                            <div
                              className={`h-full transition-all duration-200 ${
                                epVideoProgress.state === "error" ? "bg-rose-500" : "bg-[var(--primary)]"
                              }`}
                              style={{ width: `${epVideoProgress.percent}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {epVideoFeedback && (
                        <div
                          className={`p-2.5 rounded-xl text-[11px] font-medium flex items-center gap-2 ${
                            epVideoFeedback.isError
                              ? "bg-rose-500/15 border border-rose-500/35 text-rose-300"
                              : "bg-emerald-500/15 border border-emerald-500/35 text-emerald-300"
                          }`}
                        >
                          {epVideoFeedback.isError ? (
                            <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          ) : (
                            <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          )}
                          <span>{epVideoFeedback.text}</span>
                        </div>
                      )}

                      <input
                        type="text"
                        value={epQualityUrls["1080p"]}
                        onChange={(e) =>
                          setEpQualityUrls((prev) => ({ ...prev, "1080p": e.target.value }))
                        }
                        placeholder="Paste Bunny Stream HLS URL (https://vz-...b-cdn.net/.../playlist.m3u8), MP4, or YouTube URL..."
                        className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white"
                      />

                      {(() => {
                        const rawPrimary = epQualityUrls["1080p"].trim();
                        if (!rawPrimary) return null;
                        const classifiedPrimary = classifyStreamUrl(rawPrimary);
                        if (classifiedPrimary.kind === "invalid") {
                          return (
                            <p className="text-[10px] text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-2.5 py-1.5">
                              {classifiedPrimary.error}
                            </p>
                          );
                        }
                        return (
                          <div className="space-y-1.5">
                            <div
                              className={`flex items-center justify-between gap-2 text-[10px] px-2.5 py-1.5 rounded-lg border ${
                                classifiedPrimary.kind === "vidmoly"
                                  ? "bg-amber-500/10 border-amber-500/25"
                                  : "bg-white/5 border-white/10"
                              }`}
                            >
                              <span className={classifiedPrimary.kind === "vidmoly" ? "text-amber-200" : "text-neutral-300"}>
                                {classifiedPrimary.kind === "hls"
                                  ? "Bunny Stream / HLS Adaptive Playlist detected — supports automatic quality switching & multi-audio tracks."
                                  : classifiedPrimary.kind === "youtube"
                                  ? "YouTube stream detected — plays via official YouTube IFrame Player."
                                  : classifiedPrimary.kind === "vidmoly"
                                  ? "Vidmoly embed detected — note: Vidmoly sends conflicting X-Frame-Options headers that Chrome/Android block inside iframes (ERR_BLOCKED_BY_RESPONSE). Prefer Bunny Stream (.m3u8), MP4, or YouTube, or keep Vidmoly with a backup quality URL."
                                  : "Direct media stream detected."}
                              </span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {classifiedPrimary.kind === "hls" && (
                                  <button
                                    type="button"
                                    onClick={handleInspectHlsUrl}
                                    disabled={hlsInspectState?.loading}
                                    className="px-2 py-0.5 rounded bg-[var(--primary)]/20 hover:bg-[var(--primary)]/30 text-[var(--primary)] font-bold"
                                  >
                                    {hlsInspectState?.loading ? "Inspecting..." : "Inspect Renditions"}
                                  </button>
                                )}
                                <span
                                  className={`px-1.5 py-0.5 rounded font-mono font-bold uppercase ${
                                    classifiedPrimary.kind === "vidmoly"
                                      ? "bg-amber-500/20 text-amber-300"
                                      : "bg-emerald-500/20 text-emerald-300"
                                  }`}
                                >
                                  {classifiedPrimary.kind === "hls" ? "HLS .m3u8" : classifiedPrimary.kind}
                                </span>
                              </div>
                            </div>

                            {hlsInspectState && !hlsInspectState.loading && (
                              <div className="p-2 rounded-lg bg-black/40 border border-white/10 text-[10px]">
                                {hlsInspectState.error ? (
                                  <span className="text-rose-300">{hlsInspectState.error}</span>
                                ) : hlsInspectState.variants && hlsInspectState.variants.length > 0 ? (
                                  <div className="flex flex-wrap gap-1.5 items-center">
                                    <span className="text-neutral-400 font-semibold">Manifest Renditions:</span>
                                    {hlsInspectState.variants.map((v, i) => (
                                      <span
                                        key={`${v.resolution}-${i}`}
                                        className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-200 font-mono"
                                      >
                                        {v.label} ({v.resolution}) · {v.bitrateKbps} kbps
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-amber-300">Single rendition / media playlist detected.</span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                    </div>

                    {/* Additional Episode Quality Slots (720p, 480p, plus 2160p/1440p/360p when expanded) */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {VIDEO_QUALITIES.filter((qCode) => {
                        if (qCode === "1080p") return false;
                        if (qCode === "720p" || qCode === "480p") return true;
                        return showAllEpQualities || Boolean(epQualityUrls[qCode]);
                      }).map((qCode) => (
                        <div key={qCode} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-[10px] text-neutral-300 font-semibold">
                              {VIDEO_QUALITY_META[qCode].fullLabel} (Optional)
                            </label>
                            <label className={`px-2 py-1 rounded-lg bg-white/10 border border-white/15 text-[10px] font-bold text-neutral-200 cursor-pointer flex items-center gap-1 hover:bg-white/20 ${isUploadingVideo ? "opacity-50 pointer-events-none" : ""}`}>
                              <Upload className="w-3 h-3" />
                              <span>
                                {isUploadingVideo && epUploadQualityTarget === qCode
                                  ? `${epVideoProgress?.percent ?? 0}%`
                                  : `Pick ${qCode}`}
                              </span>
                              <input
                                type="file"
                                accept="video/*,video/mp4,video/webm,video/quicktime,.mkv"
                                className="hidden"
                                disabled={isUploadingVideo}
                                onChange={(e) => handleVideoUpload(e, qCode)}
                              />
                            </label>
                          </div>
                          <input
                            type="text"
                            value={epQualityUrls[qCode]}
                            onChange={(e) =>
                              setEpQualityUrls((prev) => ({ ...prev, [qCode]: e.target.value }))
                            }
                            placeholder={`Pick ${qCode} video or paste URL`}
                            className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white"
                          />
                        </div>
                      ))}
                    </div>

                    {/* Release Date & Bunny Video ID */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-neutral-300 font-semibold flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-[var(--primary)]" />
                          <span>Release Date (Optional)</span>
                        </label>
                        <input
                          type="date"
                          value={newEpReleaseDate}
                          onChange={(e) => setNewEpReleaseDate(e.target.value)}
                          className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-neutral-300 font-semibold">
                          Bunny Stream Video ID (Optional)
                        </label>
                        <input
                          type="text"
                          value={newEpBunnyVideoId}
                          onChange={(e) => setNewEpBunnyVideoId(e.target.value)}
                          placeholder="e.g. a1b2c3d4-xxxx-xxxx-xxxx..."
                          className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white font-mono"
                        />
                      </div>
                    </div>

                    {/* Optional Thumbnail URL & Description */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-[10px] text-neutral-300 font-semibold">Thumbnail URL (Optional)</label>
                          <label className="px-2 py-0.5 rounded-lg bg-white/10 border border-white/15 text-[10px] font-semibold text-neutral-200 cursor-pointer flex items-center gap-1 hover:bg-white/20">
                            <Upload className="w-3 h-3" />
                            <span>{isUploadingEpThumb ? "Uploading..." : "Gallery"}</span>
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={handleEpThumbnailUpload}
                            />
                          </label>
                        </div>
                        <input
                          type="text"
                          value={newEpThumbnailUrl}
                          onChange={(e) => setNewEpThumbnailUrl(e.target.value)}
                          placeholder="Optional episode thumbnail URL..."
                          className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-neutral-300 font-semibold">
                          Episode Description (Optional)
                        </label>
                        <input
                          type="text"
                          value={newEpDescription}
                          onChange={(e) => setNewEpDescription(e.target.value)}
                          placeholder="Optional short episode summary..."
                          className="w-full h-10 px-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] text-base sm:text-xs text-white"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                      {editingEpisodeId && (
                        <button
                          type="button"
                          onClick={handleStartAddNewEpisode}
                          className="px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold text-white"
                        >
                          Cancel Edit
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={isUploadingVideo || isUploadingEpThumb || isSavingEpisode}
                        className="theme-btn-primary px-5 py-2 rounded-xl text-xs font-bold disabled:opacity-60"
                      >
                        {isUploadingVideo
                          ? `Uploading ${epUploadQualityTarget || ""} ${epVideoProgress?.percent ?? 0}%...`
                          : isSavingEpisode
                          ? "Saving..."
                          : editingEpisodeId
                          ? "Update Episode"
                          : "Save New Episode"}
                      </button>
                    </div>
                  </form>
                )}

                {/* Search, Filter & Sort Existing Episodes */}
                <div className="space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <h4 className="text-xs font-bold text-[var(--text-muted)]">
                      Existing Episodes ({sortedFilteredManageEpisodes.length} / {episodesList.length})
                    </h4>

                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          type="text"
                          value={epSearchQuery}
                          onChange={(e) => setEpSearchQuery(e.target.value)}
                          placeholder="Search episodes..."
                          className="h-8 pl-8 pr-2.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-white w-36 sm:w-40 focus:outline-none focus:border-[var(--primary)]"
                        />
                      </div>

                      <select
                        aria-label="Filter by season"
                        value={epSeasonFilter}
                        onChange={(e) =>
                          setEpSeasonFilter(e.target.value === "ALL" ? "ALL" : Number(e.target.value))
                        }
                        className="h-8 px-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-white"
                      >
                        <option value="ALL">All Seasons</option>
                        {epSeasonsAvailable.map((s) => (
                          <option key={s} value={s}>
                            Season {s}
                          </option>
                        ))}
                      </select>

                      <select
                        aria-label="Filter by language"
                        value={epLanguageFilter}
                        onChange={(e) => setEpLanguageFilter(e.target.value)}
                        className="h-8 px-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-white"
                      >
                        <option value="ALL">All Languages</option>
                        {epLanguagesAvailable.map((lang) => (
                          <option key={lang} value={lang}>
                            {lang}
                          </option>
                        ))}
                      </select>

                      <div className="relative flex items-center">
                        <ArrowUpDown className="w-3 h-3 text-neutral-400 absolute left-2 pointer-events-none" />
                        <select
                          aria-label="Sort episodes"
                          value={epSortBy}
                          onChange={(e) => setEpSortBy(e.target.value as any)}
                          className="h-8 pl-6 pr-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-white"
                        >
                          <option value="order">Custom Order</option>
                          <option value="number-asc">Ep 1 → N</option>
                          <option value="number-desc">Ep N → 1</option>
                          <option value="season-asc">By Season</option>
                          <option value="updated-desc">Recently Updated</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Episodes Management List */}
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {sortedFilteredManageEpisodes.length === 0 ? (
                      <p className="text-xs text-neutral-400 p-4 bg-[var(--bg-surface)] rounded-xl text-center">
                        {episodesList.length === 0
                          ? "No episodes added yet. Use Add New Episode or Bulk Add above."
                          : "No episodes match your current search or filters."}
                      </p>
                    ) : (
                      sortedFilteredManageEpisodes.map((ep) => {
                        const seasonEps = episodesList.filter(
                          (item) => (item.season || 1) === (ep.season || 1)
                        );
                        const seasonIdx = seasonEps.findIndex((item) => item.id === ep.id);
                        const isFirst = seasonIdx <= 0;
                        const isLast = seasonIdx === -1 || seasonIdx >= seasonEps.length - 1;
                        const epQualities = Array.from(
                          new Set(
                            (ep.sources || [])
                              .filter((s) => Boolean(s?.url?.trim()))
                              .map((s) => normalizeQualityCode(s.quality || s.label))
                          )
                        );
                        return (
                          <div
                            key={ep.id}
                            className={`p-3 rounded-xl bg-[var(--bg-surface)] border flex items-center justify-between gap-3 text-xs transition-colors ${
                              editingEpisodeId === ep.id
                                ? "border-amber-400/60"
                                : "border-[var(--border-subtle)]"
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              {ep.thumbnailUrl ? (
                                <img
                                  src={ep.thumbnailUrl}
                                  alt={ep.title}
                                  className="w-11 h-8 rounded object-cover border border-white/10 shrink-0"
                                  referrerPolicy="no-referrer"
                                />
                              ) : (
                                <span className="px-2 h-7 rounded bg-black/40 flex items-center justify-center font-mono font-bold text-[10px] shrink-0">
                                  S{ep.season || 1}·E{ep.number}
                                </span>
                              )}

                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {ep.thumbnailUrl && (
                                    <span className="text-[10px] font-mono text-[var(--primary)] font-bold">
                                      S{ep.season || 1}·E{ep.number}
                                    </span>
                                  )}
                                  <span className="font-semibold text-white truncate">
                                    {ep.title}
                                  </span>
                                  <span className="px-1.5 py-0.5 rounded bg-[var(--badge-bg)] text-[var(--badge-text)] text-[10px] font-semibold">
                                    {ep.language || "Japanese"}
                                  </span>
                                  {epQualities.map((qTag) => {
                                    const matchingSrc = (ep.sources || []).find(
                                      (s) => normalizeQualityCode(s.quality || s.label) === qTag
                                    );
                                    const isHlsTag = matchingSrc?.type === "application/x-mpegURL";
                                    return (
                                      <span
                                        key={qTag}
                                        className="px-1.5 py-0.5 rounded bg-white/10 text-neutral-200 text-[9px] font-mono font-bold"
                                      >
                                        {isHlsTag ? "HLS ABR" : qTag}
                                      </span>
                                    );
                                  })}
                                </div>
                                {(ep.description || ep.synopsis) && (
                                  <p className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">
                                    {ep.description || ep.synopsis}
                                  </p>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => handleToggleEpisodePublish(ep)}
                                title={ep.isPublished !== false ? "Unpublish Episode" : "Publish Episode"}
                                aria-label={ep.isPublished !== false ? "Unpublish Episode" : "Publish Episode"}
                                className={`px-2 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 ${
                                  ep.isPublished !== false
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : "bg-white/10 text-neutral-400"
                                }`}
                              >
                                {ep.isPublished !== false ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                                <span className="hidden sm:inline">{ep.isPublished !== false ? "Live" : "Draft"}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => startPlayback(managingAnimeEpisodes, ep)}
                                title="Preview Episode"
                                aria-label="Preview Episode"
                                className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/15"
                              >
                                <Play className="w-3.5 h-3.5 fill-current" />
                              </button>
                              <button
                                type="button"
                                disabled={isFirst}
                                onClick={() => handleMoveEpisode(ep.id, "up")}
                                title="Move Up"
                                aria-label="Move Episode Up"
                                className="p-1.5 rounded-lg text-neutral-300 hover:bg-white/10 disabled:opacity-30"
                              >
                                <ArrowUp className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                disabled={isLast}
                                onClick={() => handleMoveEpisode(ep.id, "down")}
                                title="Move Down"
                                aria-label="Move Episode Down"
                                className="p-1.5 rounded-lg text-neutral-300 hover:bg-white/10 disabled:opacity-30"
                              >
                                <ArrowDown className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleStartEditEpisode(ep)}
                                title="Edit Episode"
                                aria-label="Edit Episode"
                                className="p-1.5 rounded-lg text-amber-300 hover:bg-amber-500/15"
                              >
                                <Edit className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteEpisode(ep.id)}
                                title="Delete Episode"
                                aria-label="Delete Episode"
                                className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-500/15"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
