import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signInWithCredential,
  getRedirectResult,
  signOut,
  GoogleAuthProvider,
} from "firebase/auth";
import { App as CapacitorApp } from "@capacitor/app";
import { SplashScreen } from "@capacitor/splash-screen";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import {
  auth,
  AUTHORIZED_ADMIN_EMAIL,
  getValidAdminIdToken,
} from "../lib/firebase";
import { apiUrl, isCapacitorNative, resolveMediaUrl } from "../utils/apiUrl";
import {
  subscribeToRealtimeCatalog,
  subscribeToUserProfile,
  saveUserProfileToFirebase,
  subscribeToUserWatchHistory,
  saveWatchHistoryToFirebase,
  clearWatchHistoryInFirebase,
  fetchAnimeEpisodesOnce,
  mergeEpisodeLists,
  type FirebaseUserProfileData,
} from "../lib/firebaseCatalog";
import { isRestrictedMatureRating } from "../utils/ageRating";
import { getStreamMimeType } from "../utils/streamUrl";
import {
  getOrCreatePersistentDeviceUid,
  syncIndexedDbDeviceUid,
} from "../utils/userIdentity";
import {
  dedupeIdList,
  dedupeWatchHistoryByAnime,
  findActiveResumeForAnime,
} from "../utils/historyDedupe";
import { sound, SoundPack } from "../utils/sound";

export type ThemeType = "emerald" | "graphite" | "astral" | "ios";
export type ThemeMode = "dark" | "light" | "system";
export type BackgroundPoster = "none" | "rengoku" | "luffy" | "mikey";

function normalizeThemePalette(raw: unknown): ThemeType {
  if (raw === "graphite" || raw === "astral" || raw === "ios" || raw === "emerald") {
    return raw;
  }
  // Automatically migrate legacy pink/crimson default to Midnight Emerald
  return "emerald";
}

export const POSTER_WALLPAPERS: Record<BackgroundPoster, string | null> = {
  none: null,
  rengoku: "/assets/aistudio/45d41c027c9d9b08d7904e871fda8640_cb4c1154.jpg",
  luffy: "/assets/aistudio/6b99f5ad24ea0e17150c200b8b8428b3_5b791649.jpg",
  mikey: "/assets/aistudio/20c40a85225912e40b51a4b4c302cc00_90a378e3.jpg",
};

export interface Anime {
  id: string;
  title: string;
  titleJapanese?: string;
  synopsis: string;
  posterImage: string;
  bannerImage: string;
  genres: string[];
  rating: string;
  ratingVerified?: boolean;
  status: "Ongoing" | "Completed";
  year: number;
  seasons?: number;
  episodesCount: number;
  isPublished: boolean;
  featured?: boolean;
  streamingSources?: { name: string; url: string; quality?: string }[];
  createdAt: string;
  updatedAt: string;
}

export const EPISODE_LANGUAGES = [
  "Hindi Dub",
  "Japanese",
  "English",
  "Tamil",
  "Telugu",
] as const;

export type EpisodeLanguage = string;

export interface Episode {
  id: string;
  animeId: string;
  number: number;
  season?: number;
  title: string;
  language?: EpisodeLanguage;
  synopsis?: string;
  description?: string;
  duration?: string;
  videoUrl: string;
  thumbnailUrl?: string;
  order?: number;
  sources?: { label: string; url: string; quality: string; type: string }[];
  isPublished?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface HistoryItem {
  animeId: string;
  animeTitle: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  season?: number;
  language?: EpisodeLanguage;
  poster: string;
  progressSeconds: number;
  durationSeconds: number;
  updatedAt: number;
}

export interface AuthUserInfo {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
}

interface AppContextType {
  // Theme & Appearance Mode
  theme: ThemeType;
  setTheme: (theme: ThemeType) => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  resolvedMode: "dark" | "light";
  themeSyncError: string | null;
  clearThemeSyncError: () => void;

  // Anime Background Poster
  backgroundPoster: BackgroundPoster;
  setBackgroundPoster: (poster: BackgroundPoster) => void;
  backgroundPosterUrl: string | null;

  // Safe Mode
  safeMode: boolean;
  setSafeMode: (val: boolean) => void;

  // Sound Engine
  soundEnabled: boolean;
  setSoundEnabled: (val: boolean) => void;
  soundPack: SoundPack;
  setSoundPack: (pack: SoundPack) => void;

  // App Lock
  isLockEnabled: boolean;
  isUnlocked: boolean;
  verifyPin: (pin: string) => boolean;
  enableLock: (pin: string) => void;
  disableLock: () => void;
  changePin: (newPin: string) => void;

  // Permanent User Identity & Profile
  userId: string;
  authUser: AuthUserInfo | null;
  isProfileSyncedToCloud: boolean;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  profilePicture: string | null;
  setProfilePicture: (url: string | null) => void;
  displayName: string;
  setDisplayName: (name: string) => Promise<void>;

  // Admin Auth (strictly verified via Firebase ID Token + Firebase Admin SDK)
  authReady: boolean;
  accessDeniedMessage: string | null;
  clearAccessDeniedMessage: () => void;
  adminToken: string | null;
  isAdmin: boolean;
  isFirebaseAdminAuthenticated: boolean;
  adminUser: { email: string; displayName: string } | null;
  getAdminAuthToken: (forceRefresh?: boolean) => Promise<string>;
  loginAdmin: (token: string | undefined, user: { email: string; displayName: string }) => void;
  logoutAdmin: () => Promise<void>;

  // Catalog State
  catalog: Anime[];
  isLoadingCatalog: boolean;
  refreshCatalog: () => Promise<void>;

  // History, Favorites & Watchlist
  history: HistoryItem[];
  saveWatchProgress: (item: Omit<HistoryItem, "updatedAt">, options?: { force?: boolean }) => void;
  clearHistory: () => void;
  favorites: string[];
  toggleFavorite: (animeId: string) => void;
  watchlist: string[];
  toggleWatchlist: (animeId: string) => void;

  // Navigation Stack
  currentView: string;
  navigateTo: (view: string, animeId?: string) => void;
  goBack: () => void;
  selectedAnimeId: string | null;
  setSelectedAnimeId: (id: string | null) => void;

  // Video Player
  activePlayingAnime: Anime | null;
  activePlayingEpisode: Episode | null;
  startPlayback: (anime: Anime, episode: Episode) => void;
  resumeAnimePlayback: (anime: Anime, targetHistory?: HistoryItem) => Promise<void>;
  closePlayback: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

function hashPin(pin: string): string {
  let hash = 0;
  for (let i = 0; i < pin.length; i++) {
    const char = pin.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `yg_pin_${Math.abs(hash * 31337 + 7919)}`;
}

function resolveSystemThemeMode(mode: ThemeMode): "dark" | "light" {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

function applyThemeToDocument(palette: ThemeType, mode: ThemeMode): "dark" | "light" {
  const resolved = resolveSystemThemeMode(mode);
  const root = document.documentElement;
  root.setAttribute("data-theme", palette);
  root.setAttribute("data-mode", resolved);
  if (resolved === "dark") {
    root.classList.add("dark");
    root.classList.remove("light");
  } else {
    root.classList.add("light");
    root.classList.remove("dark");
  }
  root.style.colorScheme = resolved;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute("content", resolved === "light" ? "#f3f7f6" : "#070b0d");
  }
  return resolved;
}

function scopedStorageKey(uid: string, key: string): string {
  const safeUid = (uid || "guest").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `yg_u_${safeUid}_${key}`;
}

function readScopedJson<T>(uid: string, key: string, legacyKey: string | null, fallback: T): T {
  try {
    const raw =
      localStorage.getItem(scopedStorageKey(uid, key)) ??
      (legacyKey ? localStorage.getItem(legacyKey) : null);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeScopedJson(uid: string, key: string, legacyKey: string | null, value: unknown): void {
  try {
    const json = JSON.stringify(value);
    localStorage.setItem(scopedStorageKey(uid, key), json);
    if (legacyKey && !auth.currentUser) {
      localStorage.setItem(legacyKey, json);
    }
  } catch {}
}

function readScopedString(uid: string, key: string, legacyKey: string | null): string | null {
  try {
    return (
      localStorage.getItem(scopedStorageKey(uid, key)) ??
      (legacyKey ? localStorage.getItem(legacyKey) : null)
    );
  } catch {
    return null;
  }
}

function writeScopedString(uid: string, key: string, legacyKey: string | null, value: string | null): void {
  try {
    const sKey = scopedStorageKey(uid, key);
    if (value === null) {
      localStorage.removeItem(sKey);
      if (legacyKey && !auth.currentUser) localStorage.removeItem(legacyKey);
    } else {
      localStorage.setItem(sKey, value);
      if (legacyKey && !auth.currentUser) localStorage.setItem(legacyKey, value);
    }
  } catch {}
}

async function buildUserApiHeaders(targetUid: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    if (auth.currentUser && auth.currentUser.uid === targetUid) {
      const token = await auth.currentUser.getIdToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
  } catch {}
  return headers;
}

function parseAppLocationPath(pathname: string): { view: string; animeId: string | null } {
  const clean = (pathname || "/").replace(/\/+$/, "") || "/";
  if (clean === "/admin") return { view: "admin", animeId: null };
  if (clean === "/admin-login") return { view: "admin-login", animeId: null };
  if (clean === "/search") return { view: "search", animeId: null };
  if (clean === "/history") return { view: "history", animeId: null };
  if (clean === "/settings") return { view: "settings", animeId: null };
  if (clean === "/more") return { view: "more", animeId: null };
  if (clean.startsWith("/anime/")) {
    const id = decodeURIComponent(clean.slice("/anime/".length).split("/")[0] || "").trim();
    if (id) return { view: "details", animeId: id };
  }
  return { view: "home", animeId: null };
}

function viewToAppPath(view: string, animeId?: string | null): string {
  switch (view) {
    case "admin":
      return "/admin";
    case "admin-login":
      return "/admin-login";
    case "search":
      return "/search";
    case "history":
      return "/history";
    case "settings":
      return "/settings";
    case "more":
      return "/more";
    case "details":
      return animeId ? `/anime/${encodeURIComponent(animeId)}` : "/";
    default:
      return "/";
  }
}

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Remove any legacy client-side admin storage keys & hide native splash screen if running in Capacitor
  useEffect(() => {
    try {
      localStorage.removeItem("yg_admin_token");
      localStorage.removeItem("yg_admin_user");
    } catch {}
    if (isCapacitorNative()) {
      SplashScreen.hide().catch(() => {});
    }
  }, []);

  // Permanent Device UID (initialized synchronously ONCE, recovered across cookie/IDB/localStorage)
  const [deviceUid, setDeviceUid] = useState<string>(() => getOrCreatePersistentDeviceUid());
  const [authUser, setAuthUser] = useState<AuthUserInfo | null>(null);
  const [isProfileSyncedToCloud, setIsProfileSyncedToCloud] = useState<boolean>(false);

  const userId = authUser?.uid || deviceUid;
  const userIdRef = useRef<string>(userId);
  userIdRef.current = userId;
  const authUserRef = useRef<AuthUserInfo | null>(authUser);
  authUserRef.current = authUser;
  const deviceUidRef = useRef<string>(deviceUid);
  deviceUidRef.current = deviceUid;

  // Appearance Mode & Theme Palette
  const [theme, setThemeState] = useState<ThemeType>(() => {
    try {
      const saved = localStorage.getItem("yg_theme");
      return normalizeThemePalette(saved);
    } catch {
      return "emerald";
    }
  });

  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem("yg_theme_mode") as ThemeMode;
      return ["dark", "light", "system"].includes(saved) ? saved : "dark";
    } catch {
      return "dark";
    }
  });

  const [resolvedMode, setResolvedMode] = useState<"dark" | "light">(() =>
    resolveSystemThemeMode(themeMode)
  );
  const [themeSyncError, setThemeSyncError] = useState<string | null>(null);
  const clearThemeSyncError = useCallback(() => setThemeSyncError(null), []);

  // Track the latest local palette/mode selection so slow/stale remote fetches or cached
  // Firestore snapshots never overwrite a theme the user just clicked.
  const latestThemeSelectionRef = useRef<{
    palette: ThemeType;
    mode: ThemeMode;
    updatedAt: number;
  }>({
    palette: theme,
    mode: themeMode,
    updatedAt: 0,
  });
  const pendingThemeSyncCountRef = useRef<number>(0);

  // Background Anime Wallpaper Poster state
  const [backgroundPoster, setBackgroundPosterState] = useState<BackgroundPoster>(() => {
    const saved = localStorage.getItem("yg_bg_poster") as BackgroundPoster;
    return ["none", "rengoku", "luffy", "mikey"].includes(saved) ? saved : "rengoku";
  });

  const backgroundPosterUrl = POSTER_WALLPAPERS[backgroundPoster] || null;

  // Safe mode state
  const [safeMode, setSafeModeState] = useState<boolean>(() => {
    const saved = localStorage.getItem("yg_safe_mode");
    return saved !== null ? saved === "true" : true;
  });

  // Sound settings
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(sound.getEnabled());
  const [soundPack, setSoundPackState] = useState<SoundPack>(sound.getPack());

  // App lock state
  const [isLockEnabled, setIsLockEnabled] = useState<boolean>(() => {
    return localStorage.getItem("yg_lock_enabled") === "true";
  });
  const [pinHash, setPinHash] = useState<string | null>(() => {
    return localStorage.getItem("yg_lock_pin");
  });
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    return localStorage.getItem("yg_lock_enabled") !== "true";
  });

  // User Profile (UID-scoped across refreshes & accounts)
  const [profilePicture, setProfilePictureState] = useState<string | null>(() => {
    return readScopedString(deviceUid, "profile_pic", "yg_profile_pic") || null;
  });
  const [displayName, setDisplayNameState] = useState<string>(() => {
    return readScopedString(deviceUid, "display_name", "yg_display_name") || "Otaku Explorer";
  });

  // Admin Auth (strictly verified via Firebase ID Token + Firebase Admin SDK on backend; zero localStorage trust)
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [accessDeniedMessage, setAccessDeniedMessage] = useState<string | null>(null);
  const clearAccessDeniedMessage = useCallback(() => setAccessDeniedMessage(null), []);
  const [isServerAdminAuthenticated, setIsServerAdminAuthenticated] = useState<boolean>(false);
  const [adminUser, setAdminUser] = useState<{ email: string; displayName: string } | null>(null);
  const [isFirebaseAdminAuthenticated, setIsFirebaseAdminAuthenticated] = useState<boolean>(false);
  const isAdmin = Boolean(
    isServerAdminAuthenticated &&
      isFirebaseAdminAuthenticated &&
      authUser?.email?.toLowerCase() === AUTHORIZED_ADMIN_EMAIL.toLowerCase() &&
      authUser?.emailVerified
  );
  const adminToken: string | null = null;
  const isAdminRef = useRef<boolean>(isAdmin);
  isAdminRef.current = isAdmin;

  const getAdminAuthToken = useCallback(async (forceRefresh = false): Promise<string> => {
    return getValidAdminIdToken(forceRefresh);
  }, []);

  // Catalog
  const [serverCatalog, setServerCatalog] = useState<Anime[]>([]);
  const [firebaseCatalog, setFirebaseCatalog] = useState<Anime[]>([]);
  const [deletedIdsCache, setDeletedIdsCache] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<Anime[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState<boolean>(true);
  const hasInitialLoadedRef = useRef<boolean>(false);

  // History, Favorites & Watchlist (UID-scoped and strictly deduplicated)
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const raw = readScopedJson<HistoryItem[]>(deviceUid, "watch_history", "yg_watch_history", []);
    return dedupeWatchHistoryByAnime(raw, 30);
  });

  const [favorites, setFavorites] = useState<string[]>(() => {
    return dedupeIdList(readScopedJson<string[]>(deviceUid, "favorites", "yg_favorites", []));
  });

  const [watchlist, setWatchlist] = useState<string[]>(() => {
    return dedupeIdList(readScopedJson<string[]>(deviceUid, "watchlist", "yg_watchlist", []));
  });

  const historyRef = useRef<HistoryItem[]>(history);
  historyRef.current = history;
  const favoritesRef = useRef<string[]>(favorites);
  favoritesRef.current = favorites;
  const watchlistRef = useRef<string[]>(watchlist);
  watchlistRef.current = watchlist;
  const pendingFavoritesSyncCountRef = useRef<number>(0);
  const pendingWatchlistSyncCountRef = useRef<number>(0);
  const pendingHistoryWriteCountRef = useRef<number>(0);

  // Navigation (synchronized with browser pathname so direct /admin URL attempts are strictly enforced)
  const initialRoute =
    typeof window !== "undefined"
      ? parseAppLocationPath(window.location.pathname)
      : { view: "home", animeId: null };
  const [currentView, setCurrentView] = useState<string>(initialRoute.view);
  const [viewHistory, setViewHistory] = useState<string[]>([initialRoute.view]);
  const [selectedAnimeId, setSelectedAnimeId] = useState<string | null>(initialRoute.animeId);
  const currentViewRef = useRef<string>(currentView);
  currentViewRef.current = currentView;

  // Video Player
  const [activePlayingAnime, setActivePlayingAnime] = useState<Anime | null>(null);
  const [activePlayingEpisode, setActivePlayingEpisode] = useState<Episode | null>(null);

  // Recover permanent guest UID from IndexedDB if needed
  useEffect(() => {
    syncIndexedDbDeviceUid(deviceUid).then((uid) => {
      if (uid && uid !== deviceUid) {
        setDeviceUid(uid);
      }
    });
  }, []);

  // Apply theme & resolved dark/light mode to <html> and listen for OS scheme changes in "system" mode
  useEffect(() => {
    try {
      localStorage.setItem("yg_theme", theme);
      localStorage.setItem("yg_theme_mode", themeMode);
    } catch {}
    const nextResolved = applyThemeToDocument(theme, themeMode);
    setResolvedMode((prev) => (prev === nextResolved ? prev : nextResolved));

    if (themeMode !== "system" || typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onSystemChange = () => {
      const updatedResolved = applyThemeToDocument(latestThemeSelectionRef.current.palette, "system");
      setResolvedMode((prev) => (prev === updatedResolved ? prev : updatedResolved));
    };
    mq.addEventListener("change", onSystemChange);
    return () => mq.removeEventListener("change", onSystemChange);
  }, [theme, themeMode]);

  // Ref snapshot of current defaults for Firestore document creation/merging
  const latestProfileRef = useRef<Omit<FirebaseUserProfileData, "uid">>({
    displayName,
    profilePicture: profilePicture || "",
    themeMode,
    colorTheme: theme,
    backgroundPoster,
    safeMode,
    soundEnabled,
    soundPack,
    favorites,
    watchlist,
  });
  latestProfileRef.current = {
    displayName,
    profilePicture: profilePicture || "",
    themeMode,
    colorTheme: theme,
    backgroundPoster,
    safeMode,
    soundEnabled,
    soundPack,
    favorites,
    watchlist,
  };

  // Persist user profile changes cleanly to backend DB + Firestore (when Firebase-signed-in)
  const syncProfileChanges = useCallback(
    async (
      partial: Partial<FirebaseUserProfileData>,
      options?: { trackThemeSync?: boolean }
    ) => {
      const targetUid = authUserRef.current?.uid || deviceUidRef.current;
      const isThemeSync = Boolean(
        options?.trackThemeSync || partial.colorTheme !== undefined || partial.themeMode !== undefined
      );

      if (isThemeSync) {
        pendingThemeSyncCountRef.current += 1;
      }

      const headers = await buildUserApiHeaders(targetUid);
      const apiPromise = fetch(apiUrl("/api/user/profile"), {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          userId: targetUid,
          ...partial,
          ...(partial.profilePicture !== undefined ? { pictureUrl: partial.profilePicture } : {}),
        }),
      }).then(async (res) => {
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `Server returned HTTP ${res.status}`);
        }
      });

      const currentAuth = authUserRef.current;
      const fbPromise =
        currentAuth?.uid && currentAuth.emailVerified
          ? saveUserProfileToFirebase(currentAuth.uid, partial, latestProfileRef.current)
          : Promise.resolve();

      Promise.allSettled([apiPromise, fbPromise])
        .then((results) => {
          if (!isThemeSync) return;
          const apiResult = results[0];
          const fbResult = results[1];
          const fbFailed = fbResult.status === "rejected";
          const apiFailed = apiResult.status === "rejected";

          if (fbFailed || apiFailed) {
            const rawErr = fbFailed
              ? (fbResult as PromiseRejectedResult).reason
              : (apiResult as PromiseRejectedResult).reason;
            const errMsg = rawErr instanceof Error ? rawErr.message : String(rawErr || "Network error");
            const isPerm = /permission|insufficient|denied/i.test(errMsg);
            console.warn("Theme preference sync notice:", errMsg);
            setThemeSyncError(
              isPerm
                ? "Theme applied locally, but cloud sync was denied by database permissions. Your selection stays active on this device."
                : "Theme applied locally, but could not sync to the server right now. Your selection stays active on this device."
            );
          }
        })
        .finally(() => {
          if (isThemeSync) {
            pendingThemeSyncCountRef.current = Math.max(0, pendingThemeSyncCountRef.current - 1);
          }
        });
    },
    []
  );

  // Sync Firebase Auth state & verify Owner Admin Authorization strictly via backend Firebase Admin SDK
  useEffect(() => {
    let disposed = false;
    getRedirectResult(auth).catch(() => {});

    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (disposed) return;

      if (!fbUser) {
        setAuthUser(null);
        setIsProfileSyncedToCloud(false);
        setIsFirebaseAdminAuthenticated(false);
        setIsServerAdminAuthenticated(false);
        setAdminUser(null);
        try {
          localStorage.removeItem("yg_admin_token");
          localStorage.removeItem("yg_admin_user");
        } catch {}
        if (currentViewRef.current === "admin") {
          setAccessDeniedMessage(
            `Access Denied: Sign in with authorized owner Gmail (${AUTHORIZED_ADMIN_EMAIL}) to open the Admin Dashboard.`
          );
          setCurrentView("home");
          setViewHistory(["home"]);
          if (typeof window !== "undefined") {
            window.history.replaceState({}, "", "/");
          }
        }
        setAuthReady(true);
        return;
      }

      setAuthUser({
        uid: fbUser.uid,
        email: fbUser.email,
        emailVerified: fbUser.emailVerified,
        displayName: fbUser.displayName,
        photoURL: fbUser.photoURL,
      });

      const isOwnerEmail = Boolean(
        fbUser.email &&
          fbUser.email.trim().toLowerCase() === AUTHORIZED_ADMIN_EMAIL.toLowerCase() &&
          fbUser.emailVerified
      );

      let serverConfirmedAdmin = false;
      let serverUserPayload: { email: string; displayName: string } | null = null;

      try {
        const firebaseIdToken = await fbUser.getIdToken();
        const res = await fetch(apiUrl("/api/auth/session"), {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${firebaseIdToken}`,
          },
          body: JSON.stringify({ idToken: firebaseIdToken }),
        });

        if (res.ok) {
          const data = await res.json().catch(() => null);
          serverConfirmedAdmin = Boolean(data?.isAdmin && isOwnerEmail);
          if (serverConfirmedAdmin && data?.user) {
            serverUserPayload = {
              email: data.user.email || fbUser.email || AUTHORIZED_ADMIN_EMAIL,
              displayName: data.user.displayName || "Authorized Admin Owner",
            };
          }
          if (data?.claimSync?.status === "synced") {
            await fbUser.getIdToken(true).catch(() => {});
          }
        }
      } catch {
        serverConfirmedAdmin = false;
      }

      if (disposed) return;

      if (serverConfirmedAdmin && isOwnerEmail) {
        setIsFirebaseAdminAuthenticated(true);
        setIsServerAdminAuthenticated(true);
        setAdminUser(
          serverUserPayload || {
            email: fbUser.email || AUTHORIZED_ADMIN_EMAIL,
            displayName: "Authorized Admin Owner",
          }
        );
        setAccessDeniedMessage(null);
      } else {
        setIsFirebaseAdminAuthenticated(false);
        setIsServerAdminAuthenticated(false);
        setAdminUser(null);
        if (currentViewRef.current === "admin") {
          setAccessDeniedMessage(
            `Access Denied: Account "${fbUser.email || "user"}" is not authorized for Admin access. Redirected to Home.`
          );
          setCurrentView("home");
          setViewHistory(["home"]);
          if (typeof window !== "undefined") {
            window.history.replaceState({}, "", "/");
          }
        }
      }

      setAuthReady(true);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // Load & subscribe to active User Profile + Watch History strictly isolated per active UID
  const previousHydratedUidRef = useRef<string>(userId);
  useEffect(() => {
    let cancelled = false;
    const isGuestUid = !authUser?.uid;
    const legacyPrefix = isGuestUid;

    // If active UID changed (login, logout, or account switch), immediately swap local state to target UID's sandbox
    if (previousHydratedUidRef.current !== userId) {
      previousHydratedUidRef.current = userId;
      const scopedHistory = dedupeWatchHistoryByAnime(
        readScopedJson<HistoryItem[]>(userId, "watch_history", legacyPrefix ? "yg_watch_history" : null, []),
        30
      );
      const scopedFavs = dedupeIdList(
        readScopedJson<string[]>(userId, "favorites", legacyPrefix ? "yg_favorites" : null, [])
      );
      const scopedWatchlist = dedupeIdList(
        readScopedJson<string[]>(userId, "watchlist", legacyPrefix ? "yg_watchlist" : null, [])
      );
      const scopedName =
        readScopedString(userId, "display_name", legacyPrefix ? "yg_display_name" : null) ||
        authUser?.displayName ||
        "Otaku Explorer";
      const scopedPic =
        readScopedString(userId, "profile_pic", legacyPrefix ? "yg_profile_pic" : null) ||
        authUser?.photoURL ||
        null;

      setHistory(scopedHistory);
      setFavorites(scopedFavs);
      setWatchlist(scopedWatchlist);
      setDisplayNameState(scopedName);
      setProfilePictureState(scopedPic);
    }

    const applyServerProfile = (p: any) => {
      if (cancelled || !p || typeof p !== "object") return;
      if (typeof p.displayName === "string" && p.displayName.trim()) {
        const cleanName = p.displayName.trim();
        setDisplayNameState(cleanName);
        writeScopedString(userId, "display_name", legacyPrefix ? "yg_display_name" : null, cleanName);
      }
      if (typeof p.pictureUrl === "string" && p.pictureUrl) {
        setProfilePictureState(p.pictureUrl);
        writeScopedString(userId, "profile_pic", legacyPrefix ? "yg_profile_pic" : null, p.pictureUrl);
      }
      const hasActiveLocalThemeEdit =
        pendingThemeSyncCountRef.current > 0 ||
        (latestThemeSelectionRef.current.updatedAt > 0 &&
          Date.now() - latestThemeSelectionRef.current.updatedAt < 8000);

      if (!hasActiveLocalThemeEdit) {
        let resolvedNextMode = latestThemeSelectionRef.current.mode;
        let resolvedNextPalette = latestThemeSelectionRef.current.palette;
        let themeChangedFromRemote = false;

        if (["dark", "light", "system"].includes(p.themeMode) && p.themeMode !== resolvedNextMode) {
          resolvedNextMode = p.themeMode;
          latestThemeSelectionRef.current.mode = resolvedNextMode;
          setThemeModeState(resolvedNextMode);
          try {
            localStorage.setItem("yg_theme_mode", resolvedNextMode);
          } catch {}
          themeChangedFromRemote = true;
        }
        if (typeof p.colorTheme === "string") {
          const nextPalette = normalizeThemePalette(p.colorTheme);
          if (nextPalette !== resolvedNextPalette) {
            resolvedNextPalette = nextPalette;
            latestThemeSelectionRef.current.palette = nextPalette;
            setThemeState(nextPalette);
            try {
              localStorage.setItem("yg_theme", nextPalette);
            } catch {}
            themeChangedFromRemote = true;
          }
        }
        if (themeChangedFromRemote) {
          const nextResolved = applyThemeToDocument(resolvedNextPalette, resolvedNextMode);
          setResolvedMode((prev) => (prev === nextResolved ? prev : nextResolved));
        }
      }
      if (["none", "rengoku", "luffy", "mikey"].includes(p.backgroundPoster)) {
        setBackgroundPosterState(p.backgroundPoster);
        localStorage.setItem("yg_bg_poster", p.backgroundPoster);
      }
      if (typeof p.safeMode === "boolean") {
        setSafeModeState(p.safeMode);
        localStorage.setItem("yg_safe_mode", String(p.safeMode));
      }
      if (typeof p.soundEnabled === "boolean") {
        setSoundEnabledState(p.soundEnabled);
        sound.setEnabled(p.soundEnabled);
      }
      if (["cyber", "retro", "soft"].includes(p.soundPack)) {
        setSoundPackState(p.soundPack);
        sound.setPack(p.soundPack);
      }
      if (Array.isArray(p.favorites) && pendingFavoritesSyncCountRef.current === 0) {
        const cleanFavs = dedupeIdList(p.favorites);
        setFavorites(cleanFavs);
        writeScopedJson(userId, "favorites", legacyPrefix ? "yg_favorites" : null, cleanFavs);
      }
      if (Array.isArray(p.watchlist) && pendingWatchlistSyncCountRef.current === 0) {
        const cleanWl = dedupeIdList(p.watchlist);
        setWatchlist(cleanWl);
        writeScopedJson(userId, "watchlist", legacyPrefix ? "yg_watchlist" : null, cleanWl);
      }
      if (Array.isArray(p.watchHistory) && pendingHistoryWriteCountRef.current === 0) {
        if (p.watchHistory.length > 0) {
          setHistory((prev) => {
            const merged = dedupeWatchHistoryByAnime([...prev, ...p.watchHistory], 30);
            writeScopedJson(userId, "watch_history", legacyPrefix ? "yg_watch_history" : null, merged);
            return merged;
          });
        }
      }
    };

    // Always restore persisted server-side profile for current UID (deviceUid or Google UID)
    buildUserApiHeaders(userId)
      .then((headers) =>
        fetch(apiUrl(`/api/user/profile?userId=${encodeURIComponent(userId)}`), {
          credentials: "include",
          headers,
        })
      )
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data) => {
        if (!cancelled && data?.profile) {
          applyServerProfile(data.profile);
          // Seed server record ONLY with current UID's own values (never cross-account state)
          if (!data.profile.displayName || !data.profile.themeMode) {
            const postHeaders = await buildUserApiHeaders(userId);
            const seedFavs = Array.isArray(data.profile.favorites)
              ? dedupeIdList(data.profile.favorites)
              : isGuestUid
              ? favoritesRef.current
              : [];
            const seedWl = Array.isArray(data.profile.watchlist)
              ? dedupeIdList(data.profile.watchlist)
              : isGuestUid
              ? watchlistRef.current
              : [];
            fetch(apiUrl("/api/user/profile"), {
              method: "POST",
              credentials: "include",
              headers: postHeaders,
              body: JSON.stringify({
                userId,
                displayName:
                  data.profile.displayName ||
                  authUser?.displayName ||
                  (isGuestUid ? latestProfileRef.current.displayName : "Otaku Explorer"),
                themeMode: data.profile.themeMode || latestProfileRef.current.themeMode,
                colorTheme: data.profile.colorTheme || latestProfileRef.current.colorTheme,
                backgroundPoster:
                  data.profile.backgroundPoster || latestProfileRef.current.backgroundPoster,
                safeMode:
                  typeof data.profile.safeMode === "boolean"
                    ? data.profile.safeMode
                    : latestProfileRef.current.safeMode,
                favorites: seedFavs,
                watchlist: seedWl,
              }),
            }).catch(() => {});
          }
        }
      })
      .catch(() => {});

    let unsubFsProfile: () => void = () => {};
    let unsubFsHistory: () => void = () => {};

    if (authUser?.uid && authUser.emailVerified) {
      unsubFsProfile = subscribeToUserProfile(authUser.uid, (fbProfile) => {
        if (cancelled) return;
        setIsProfileSyncedToCloud(true);
        if (!fbProfile) {
          // Initialize Firestore user document cleanly for THIS account only (never leak another account's arrays)
          const cleanDefaults: Omit<FirebaseUserProfileData, "uid"> = {
            displayName: authUser.displayName || "Otaku Explorer",
            profilePicture: authUser.photoURL || "",
            themeMode: latestThemeSelectionRef.current.mode,
            colorTheme: latestThemeSelectionRef.current.palette,
            backgroundPoster: latestProfileRef.current.backgroundPoster,
            safeMode: latestProfileRef.current.safeMode,
            soundEnabled: latestProfileRef.current.soundEnabled,
            soundPack: latestProfileRef.current.soundPack,
            favorites: [],
            watchlist: [],
          };
          saveUserProfileToFirebase(authUser.uid, {}, cleanDefaults).catch(() => {});
          return;
        }
        applyServerProfile({
          ...fbProfile,
          pictureUrl: fbProfile.profilePicture,
        });
      });

      unsubFsHistory = subscribeToUserWatchHistory(authUser.uid, (fbHistory, meta) => {
        if (cancelled || pendingHistoryWriteCountRef.current > 0) return;
        if (fbHistory.length === 0) {
          // Authoritative server empty snapshot handles remote clearHistory() cleanly
          if (!meta?.fromCache) {
            setHistory([]);
            writeScopedJson(userId, "watch_history", null, []);
          }
          return;
        }
        setHistory((prev) => {
          const merged = dedupeWatchHistoryByAnime([...prev, ...fbHistory], 30);
          writeScopedJson(userId, "watch_history", null, merged);
          return merged;
        });
      });
    }

    return () => {
      cancelled = true;
      unsubFsProfile();
      unsubFsHistory();
    };
  }, [userId, authUser?.uid, authUser?.emailVerified]);

  // Setting mutators (instant synchronous DOM apply + async DB & Firestore sync)
  const setTheme = useCallback(
    (newTheme: ThemeType) => {
      const normalized = normalizeThemePalette(newTheme);
      latestThemeSelectionRef.current = {
        ...latestThemeSelectionRef.current,
        palette: normalized,
        updatedAt: Date.now(),
      };
      setThemeSyncError(null);
      try {
        localStorage.setItem("yg_theme", normalized);
      } catch {}
      const nextResolved = applyThemeToDocument(normalized, latestThemeSelectionRef.current.mode);
      setThemeState((prev) => (prev === normalized ? prev : normalized));
      setResolvedMode((prev) => (prev === nextResolved ? prev : nextResolved));
      try {
        sound.playClick();
      } catch {}
      syncProfileChanges({ colorTheme: normalized }, { trackThemeSync: true });
    },
    [syncProfileChanges]
  );

  const setThemeMode = useCallback(
    (newMode: ThemeMode) => {
      const normalizedMode: ThemeMode = ["dark", "light", "system"].includes(newMode)
        ? newMode
        : "dark";
      latestThemeSelectionRef.current = {
        ...latestThemeSelectionRef.current,
        mode: normalizedMode,
        updatedAt: Date.now(),
      };
      setThemeSyncError(null);
      try {
        localStorage.setItem("yg_theme_mode", normalizedMode);
      } catch {}
      const nextResolved = applyThemeToDocument(latestThemeSelectionRef.current.palette, normalizedMode);
      setThemeModeState((prev) => (prev === normalizedMode ? prev : normalizedMode));
      setResolvedMode((prev) => (prev === nextResolved ? prev : nextResolved));
      try {
        sound.playClick();
      } catch {}
      syncProfileChanges({ themeMode: normalizedMode }, { trackThemeSync: true });
    },
    [syncProfileChanges]
  );

  const setBackgroundPoster = useCallback(
    (poster: BackgroundPoster) => {
      setBackgroundPosterState(poster);
      localStorage.setItem("yg_bg_poster", poster);
      sound.playClick();
      syncProfileChanges({ backgroundPoster: poster });
    },
    [syncProfileChanges]
  );

  const setSafeMode = useCallback(
    (val: boolean) => {
      setSafeModeState(val);
      localStorage.setItem("yg_safe_mode", String(val));
      sound.playClick();
      syncProfileChanges({ safeMode: val });
    },
    [syncProfileChanges]
  );

  const setSoundEnabled = useCallback(
    (val: boolean) => {
      setSoundEnabledState(val);
      sound.setEnabled(val);
      syncProfileChanges({ soundEnabled: val });
    },
    [syncProfileChanges]
  );

  const setSoundPack = useCallback(
    (pack: SoundPack) => {
      setSoundPackState(pack);
      sound.setPack(pack);
      sound.playClick();
      syncProfileChanges({ soundPack: pack });
    },
    [syncProfileChanges]
  );

  const setProfilePicture = useCallback(
    (url: string | null) => {
      const uid = userIdRef.current;
      const isGuest = !authUserRef.current?.uid;
      setProfilePictureState(url);
      writeScopedString(uid, "profile_pic", isGuest ? "yg_profile_pic" : null, url);
      syncProfileChanges({ profilePicture: url || "" });
    },
    [syncProfileChanges]
  );

  const setDisplayName = useCallback(
    async (name: string) => {
      const clean = name.trim().slice(0, 32);
      if (!clean) return;
      const uid = userIdRef.current;
      const isGuest = !authUserRef.current?.uid;
      setDisplayNameState(clean);
      writeScopedString(uid, "display_name", isGuest ? "yg_display_name" : null, clean);
      sound.playSuccess();
      try {
        const headers = await buildUserApiHeaders(uid);
        await fetch(apiUrl("/api/user/username"), {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ userId: uid, displayName: clean }),
        });
      } catch (err) {
        console.error("Failed to sync username to server:", err);
      }
      syncProfileChanges({ displayName: clean });
    },
    [syncProfileChanges]
  );

  // Viewer Google Sign-In & Sign-Out (supports Native Capacitor Android Google Sign-In + Web Popup/Redirect)
  const signInWithGoogle = useCallback(async () => {
    if (isCapacitorNative()) {
      try {
        const nativeRes = await FirebaseAuthentication.signInWithGoogle();
        const idToken = nativeRes?.credential?.idToken;
        if (idToken) {
          const credential = GoogleAuthProvider.credential(idToken);
          await signInWithCredential(auth, credential);
          sound.playSuccess();
          return;
        }
      } catch (nativeErr: any) {
        console.warn("Native Google Sign-In fallback:", nativeErr?.message || nativeErr);
        // Fall through to web auth fallback only if popup/redirect is supported
      }
    }

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await signInWithPopup(auth, provider);
      sound.playSuccess();
    } catch (err: any) {
      if (
        err?.code === "auth/popup-blocked" ||
        err?.code === "auth/operation-not-supported-in-this-environment"
      ) {
        await signInWithRedirect(auth, provider);
        return;
      }
      throw err;
    }
  }, []);

  const signOutUser = useCallback(async () => {
    await fetch(apiUrl("/api/auth/admin-logout"), {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    if (isCapacitorNative()) {
      await FirebaseAuthentication.signOut().catch(() => {});
    }
    await signOut(auth);
    setAuthUser(null);
    setIsFirebaseAdminAuthenticated(false);
    setIsServerAdminAuthenticated(false);
    setAdminUser(null);
    setIsProfileSyncedToCloud(false);
    try {
      localStorage.removeItem("yg_admin_user");
      localStorage.removeItem("yg_admin_token");
    } catch {}
    if (currentViewRef.current === "admin") {
      setCurrentView("home");
      setViewHistory(["home"]);
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", "/");
      }
    }
    sound.playNavigate();
    refreshCatalogRef.current();
  }, []);

  // App Lock Logic
  const verifyPin = useCallback(
    (pin: string): boolean => {
      if (!pinHash) return true;
      const computed = hashPin(pin);
      if (computed === pinHash) {
        setIsUnlocked(true);
        sound.playSuccess();
        return true;
      }
      sound.playError();
      return false;
    },
    [pinHash]
  );

  const enableLock = useCallback((pin: string) => {
    const hashed = hashPin(pin);
    setPinHash(hashed);
    setIsLockEnabled(true);
    setIsUnlocked(true);
    localStorage.setItem("yg_lock_enabled", "true");
    localStorage.setItem("yg_lock_pin", hashed);
    sound.playSuccess();
  }, []);

  const disableLock = useCallback(() => {
    setIsLockEnabled(false);
    setIsUnlocked(true);
    setPinHash(null);
    localStorage.removeItem("yg_lock_enabled");
    localStorage.removeItem("yg_lock_pin");
    sound.playSuccess();
  }, []);

  const changePin = useCallback((newPin: string) => {
    const hashed = hashPin(newPin);
    setPinHash(hashed);
    localStorage.setItem("yg_lock_pin", hashed);
    sound.playSuccess();
  }, []);

  // Admin Auth Logic (verified strictly against Firebase ID Token + server)
  const loginAdmin = useCallback(
    (_token: string | undefined, user: { email: string; displayName: string }) => {
      const normalized = (user?.email || "").trim().toLowerCase();
      if (normalized !== AUTHORIZED_ADMIN_EMAIL.toLowerCase()) {
        setAccessDeniedMessage(
          `Access Denied: Only authorized owner Gmail (${AUTHORIZED_ADMIN_EMAIL}) has Admin access.`
        );
        sound.playError();
        return;
      }
      setIsServerAdminAuthenticated(true);
      setIsFirebaseAdminAuthenticated(true);
      setAdminUser(user);
      setAccessDeniedMessage(null);
      sound.playSuccess();
      refreshCatalogRef.current();
    },
    []
  );

  const logoutAdmin = useCallback(async () => {
    try {
      await fetch(apiUrl("/api/auth/admin-logout"), {
        method: "POST",
        credentials: "include",
      });
    } catch (e) {
      console.error("Logout API call error:", e);
    }
    if (isCapacitorNative()) {
      await FirebaseAuthentication.signOut().catch(() => {});
    }
    try {
      await signOut(auth);
    } catch (e) {
      console.error("Firebase signOut error:", e);
    }
    setAuthUser(null);
    setIsProfileSyncedToCloud(false);
    setIsServerAdminAuthenticated(false);
    setAdminUser(null);
    setIsFirebaseAdminAuthenticated(false);
    try {
      localStorage.removeItem("yg_admin_user");
      localStorage.removeItem("yg_admin_token");
    } catch {}
    if (currentViewRef.current === "admin") {
      setCurrentView("home");
      setViewHistory(["home"]);
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", "/");
      }
    }
    sound.playNavigate();
    refreshCatalogRef.current();
  }, []);

  // Merge Firebase realtime items + server catalog keeping the newest updatedAt & preserving streamingSources
  useEffect(() => {
    const deletedSet = new Set(deletedIdsCache);
    const mergedMap = new Map<string, Anime>();

    const upsertLatest = (rawItem: Anime) => {
      if (!rawItem?.id || deletedSet.has(rawItem.id)) return;
      const item: Anime = {
        ...rawItem,
        genres: Array.isArray(rawItem.genres) ? rawItem.genres : [],
      };
      const existing = mergedMap.get(item.id);
      if (!existing) {
        mergedMap.set(item.id, item);
        return;
      }
      const existingTs = new Date(existing.updatedAt || existing.createdAt || 0).getTime() || 0;
      const incomingTs = new Date(item.updatedAt || item.createdAt || 0).getTime() || 0;
      const newer = incomingTs >= existingTs ? item : existing;
      const older = incomingTs >= existingTs ? existing : item;
      const mergedSources =
        newer.streamingSources && newer.streamingSources.length > 0
          ? newer.streamingSources
          : older.streamingSources || [];
      const mergedGenres =
        Array.isArray(newer.genres) && newer.genres.length > 0
          ? newer.genres
          : Array.isArray(older.genres)
          ? older.genres
          : [];
      mergedMap.set(item.id, {
        ...newer,
        genres: mergedGenres,
        streamingSources: mergedSources,
      });
    };

    for (const item of serverCatalog) upsertLatest(item);
    for (const item of firebaseCatalog) upsertLatest(item);

    let mergedList = Array.from(mergedMap.values());
    if (!isAdmin) {
      mergedList = mergedList.filter((a) => a.isPublished);
    }
    if (safeMode) {
      mergedList = mergedList.filter((a) => !isRestrictedMatureRating(a.rating));
    }
    mergedList.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const normalizedList = isCapacitorNative()
      ? mergedList.map((a) => ({
          ...a,
          posterImage: resolveMediaUrl(a.posterImage),
          bannerImage: resolveMediaUrl(a.bannerImage),
          streamingSources: Array.isArray(a.streamingSources)
            ? a.streamingSources.map((s) => ({ ...s, url: resolveMediaUrl(s.url) }))
            : [],
        }))
      : mergedList;

    setCatalog(normalizedList);

    if (hasInitialLoadedRef.current) {
      const uid = userIdRef.current;
      const isGuest = !authUserRef.current?.uid;

      setHistory((prevHistory) => {
        const validHistory = prevHistory.filter(
          (h) => mergedList.some((a) => a.id === h.animeId) && !deletedSet.has(h.animeId)
        );
        if (validHistory.length === prevHistory.length) {
          return prevHistory;
        }
        writeScopedJson(uid, "watch_history", isGuest ? "yg_watch_history" : null, validHistory);
        return validHistory;
      });

      setFavorites((prevFavs) => {
        const validFavs = prevFavs.filter(
          (id) => mergedList.some((a) => a.id === id) && !deletedSet.has(id)
        );
        if (validFavs.length === prevFavs.length) {
          return prevFavs;
        }
        writeScopedJson(uid, "favorites", isGuest ? "yg_favorites" : null, validFavs);
        return validFavs;
      });

      setWatchlist((prevWl) => {
        const validWl = prevWl.filter(
          (id) => mergedList.some((a) => a.id === id) && !deletedSet.has(id)
        );
        if (validWl.length === prevWl.length) {
          return prevWl;
        }
        writeScopedJson(uid, "watchlist", isGuest ? "yg_watchlist" : null, validWl);
        return validWl;
      });
    }
  }, [serverCatalog, firebaseCatalog, deletedIdsCache, safeMode, isAdmin]);

  // Subscribe to Firebase Realtime Database + Firestore listeners for automatic live updates
  useEffect(() => {
    const unsubscribe = subscribeToRealtimeCatalog(isAdmin, (items, fbDeletedIds) => {
      setFirebaseCatalog(items);
      if (fbDeletedIds.length > 0) {
        setDeletedIdsCache((prev) => {
          const merged = Array.from(new Set([...prev, ...fbDeletedIds]));
          return merged.length === prev.length ? prev : merged;
        });
      }
      hasInitialLoadedRef.current = true;
      setIsLoadingCatalog(false);
    });
    return () => unsubscribe();
  }, [isAdmin]);

  // Fetch Catalog from backend server as well (attaches Bearer Firebase ID Token when Admin)
  const refreshCatalog = useCallback(async () => {
    if (!hasInitialLoadedRef.current) {
      setIsLoadingCatalog(true);
    }
    try {
      const headers: Record<string, string> = {};
      if (isAdmin) {
        const token = await getValidAdminIdToken(false);
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      const params = new URLSearchParams({
        safeMode: String(safeMode),
        includeUnpublished: isAdmin ? "true" : "false",
      });
      const res = await fetch(apiUrl(`/api/anime?${params.toString()}`), {
        credentials: "include",
        headers,
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          window.dispatchEvent(new CustomEvent("yg:network-check"));
          return;
        }
        const data = await res.json();
        const freshList: Anime[] = data.anime || [];
        const deletedIds: string[] = data.deletedAnimeIds || [];
        setServerCatalog(freshList);
        if (deletedIds.length > 0) {
          setDeletedIdsCache((prev) => {
            const merged = Array.from(new Set([...prev, ...deletedIds]));
            return merged.length === prev.length ? prev : merged;
          });
        }
        hasInitialLoadedRef.current = true;
      }
    } catch (err: any) {
      console.error("Failed to load catalog:", err);
      if (err?.name !== "AbortError") {
        window.dispatchEvent(new CustomEvent("yg:network-check"));
      }
    } finally {
      setIsLoadingCatalog(false);
    }
  }, [safeMode, isAdmin]);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  const refreshCatalogRef = useRef(refreshCatalog);
  refreshCatalogRef.current = refreshCatalog;

  // Subscribe to Express SSE realtime catalog updates so all connected users update instantaneously
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(apiUrl("/api/catalog-events"));
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed?.type === "catalog-updated") {
          refreshCatalogRef.current();
          window.dispatchEvent(new CustomEvent("yg:catalog-updated"));
        }
      } catch {}
    };
    return () => {
      es.close();
    };
  }, []);

  // Watch progress persistence (localStorage + Server UID DB + Firestore watchHistory, strictly 1 entry per animeId)
  const lastRemoteHistoryWriteRef = useRef<number>(0);

  const saveWatchProgress = useCallback(
    (item: Omit<HistoryItem, "updatedAt">, options?: { force?: boolean }) => {
      const uid = userIdRef.current;
      const isGuest = !authUserRef.current?.uid;
      const now = Date.now();
      const stampedItem: HistoryItem = { ...item, updatedAt: now };

      const nextHistory = dedupeWatchHistoryByAnime(
        [stampedItem, ...historyRef.current.filter((h) => h.animeId !== item.animeId)],
        30
      );
      historyRef.current = nextHistory;
      writeScopedJson(uid, "watch_history", isGuest ? "yg_watch_history" : null, nextHistory);
      setHistory(nextHistory);

      const shouldSkipRemote = !options?.force && now - lastRemoteHistoryWriteRef.current < 4000;
      if (shouldSkipRemote) return;
      lastRemoteHistoryWriteRef.current = now;

      pendingHistoryWriteCountRef.current += 1;
      const activeUid = authUserRef.current?.uid || deviceUidRef.current;

      const sendRemote = async () => {
        try {
          const headers = await buildUserApiHeaders(activeUid);
          await fetch(apiUrl("/api/user/watch-history"), {
            method: "POST",
            credentials: "include",
            keepalive: Boolean(options?.force),
            headers,
            body: JSON.stringify({ userId: activeUid, item }),
          }).catch(() => {});

          const curAuth = authUserRef.current;
          if (curAuth?.uid && curAuth.emailVerified) {
            await saveWatchHistoryToFirebase(curAuth.uid, item, latestProfileRef.current).catch(
              () => {}
            );
          }
        } finally {
          pendingHistoryWriteCountRef.current = Math.max(0, pendingHistoryWriteCountRef.current - 1);
        }
      };

      void sendRemote();
    },
    []
  );

  const clearHistory = useCallback(() => {
    const uid = userIdRef.current;
    const isGuest = !authUserRef.current?.uid;
    historyRef.current = [];
    setHistory([]);
    writeScopedJson(uid, "watch_history", isGuest ? "yg_watch_history" : null, []);
    sound.playClick();

    const activeUid = authUserRef.current?.uid || deviceUidRef.current;
    buildUserApiHeaders(activeUid)
      .then((headers) =>
        fetch(apiUrl(`/api/user/watch-history?userId=${encodeURIComponent(activeUid)}`), {
          method: "DELETE",
          credentials: "include",
          headers,
        })
      )
      .catch(() => {});

    const curAuth = authUserRef.current;
    if (curAuth?.uid && curAuth.emailVerified) {
      clearWatchHistoryInFirebase(curAuth.uid).catch(() => {});
    }
  }, []);

  // Favorites & Watchlist (strict side-effect separation, deduplicated, zero stale overwrites)
  const toggleFavorite = useCallback(
    (animeId: string) => {
      if (!animeId) return;
      const uid = userIdRef.current;
      const isGuest = !authUserRef.current?.uid;
      const current = favoritesRef.current;
      const exists = current.includes(animeId);
      const next = dedupeIdList(
        exists ? current.filter((id) => id !== animeId) : [...current, animeId]
      );
      favoritesRef.current = next;
      setFavorites(next);
      writeScopedJson(uid, "favorites", isGuest ? "yg_favorites" : null, next);
      sound.playClick();

      pendingFavoritesSyncCountRef.current += 1;
      syncProfileChanges({ favorites: next }).finally(() => {
        pendingFavoritesSyncCountRef.current = Math.max(
          0,
          pendingFavoritesSyncCountRef.current - 1
        );
      });
    },
    [syncProfileChanges]
  );

  const toggleWatchlist = useCallback(
    (animeId: string) => {
      if (!animeId) return;
      const uid = userIdRef.current;
      const isGuest = !authUserRef.current?.uid;
      const current = watchlistRef.current;
      const exists = current.includes(animeId);
      const next = dedupeIdList(
        exists ? current.filter((id) => id !== animeId) : [...current, animeId]
      );
      watchlistRef.current = next;
      setWatchlist(next);
      writeScopedJson(uid, "watchlist", isGuest ? "yg_watchlist" : null, next);
      sound.playClick();

      pendingWatchlistSyncCountRef.current += 1;
      syncProfileChanges({ watchlist: next }).finally(() => {
        pendingWatchlistSyncCountRef.current = Math.max(
          0,
          pendingWatchlistSyncCountRef.current - 1
        );
      });
    },
    [syncProfileChanges]
  );

  // Navigation & strict /admin URL authorization guard
  const viewHistoryRef = useRef<string[]>(viewHistory);
  viewHistoryRef.current = viewHistory;
  const activePlayingEpisodeRef = useRef<Episode | null>(activePlayingEpisode);
  activePlayingEpisodeRef.current = activePlayingEpisode;
  const authReadyRef = useRef<boolean>(authReady);
  authReadyRef.current = authReady;

  const navigateTo = useCallback((view: string, animeId?: string) => {
    if (view === "admin" && authReadyRef.current && !isAdminRef.current) {
      sound.playError();
      setAccessDeniedMessage(
        `Access Denied: Admin Dashboard is restricted exclusively to ${AUTHORIZED_ADMIN_EMAIL}.`
      );
      setViewHistory(["home"]);
      setCurrentView("home");
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", "/");
      }
      return;
    }

    if (animeId) {
      setSelectedAnimeId(animeId);
    }
    if (view !== "admin") {
      setAccessDeniedMessage(null);
    }
    setViewHistory((prev) => [...prev, view]);
    setCurrentView(view);
    if (typeof window !== "undefined") {
      const targetPath = viewToAppPath(view, animeId);
      if (window.location.pathname !== targetPath) {
        window.history.pushState({ view, animeId }, "", targetPath);
      }
    }
    sound.playNavigate();
  }, []);

  const closePlayback = useCallback(() => {
    setActivePlayingAnime(null);
    setActivePlayingEpisode(null);
    sound.playClick();
  }, []);

  const goBack = useCallback(() => {
    if (activePlayingEpisodeRef.current) {
      closePlayback();
      return;
    }
    sound.playNavigate();
    const stack = viewHistoryRef.current;
    if (stack.length > 1) {
      const nextStack = [...stack];
      nextStack.pop();
      const previous = nextStack[nextStack.length - 1];
      if (previous === "admin" && !isAdminRef.current) {
        setViewHistory(["home"]);
        setCurrentView("home");
        if (typeof window !== "undefined") {
          window.history.replaceState({}, "", "/");
        }
        return;
      }
      setViewHistory(nextStack);
      setCurrentView(previous);
    } else {
      setCurrentView("home");
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", "/");
      }
    }
  }, [closePlayback]);

  // Handle browser back/forward button & direct URL navigation (Android back + /admin protection)
  useEffect(() => {
    const handlePopState = () => {
      if (activePlayingEpisodeRef.current) {
        closePlayback();
        return;
      }
      const parsed = parseAppLocationPath(window.location.pathname);
      if (parsed.view === "admin" && authReadyRef.current && !isAdminRef.current) {
        sound.playError();
        setAccessDeniedMessage(
          `Access Denied: Admin privileges are restricted exclusively to ${AUTHORIZED_ADMIN_EMAIL}.`
        );
        setCurrentView("home");
        setViewHistory(["home"]);
        window.history.replaceState({}, "", "/");
        return;
      }
      if (parsed.animeId) {
        setSelectedAnimeId(parsed.animeId);
      }
      setCurrentView(parsed.view);
    };
    window.addEventListener("popstate", handlePopState);

    let removeAndroidBack: (() => void) | null = null;
    let disposed = false;
    if (isCapacitorNative()) {
      CapacitorApp.addListener("backButton", () => {
        if (activePlayingEpisodeRef.current) {
          const ev = new CustomEvent("yg:android-back", { cancelable: true });
          const notHandled = window.dispatchEvent(ev);
          if (notHandled) {
            closePlayback();
          }
          return;
        }
        if (viewHistoryRef.current.length > 1) {
          goBack();
          return;
        }
        if (currentViewRef.current !== "home") {
          navigateTo("home");
          return;
        }
        CapacitorApp.exitApp().catch(() => {});
      })
        .then((handle) => {
          if (disposed) {
            handle.remove().catch(() => {});
          } else {
            removeAndroidBack = () => handle.remove().catch(() => {});
          }
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      removeAndroidBack?.();
      window.removeEventListener("popstate", handlePopState);
    };
  }, [closePlayback, goBack, navigateTo]);

  // Video playback
  const startPlayback = useCallback((anime: Anime, episode: Episode) => {
    setActivePlayingAnime(anime);
    setActivePlayingEpisode(episode);
    sound.playClick();
  }, []);

  const resumeAnimePlayback = useCallback(
    async (anime: Anime, targetHistory?: HistoryItem) => {
      const saved =
        targetHistory || findActiveResumeForAnime(historyRef.current, anime.id) || historyRef.current.find((h) => h.animeId === anime.id);
      if (!saved) {
        navigateTo("details", anime.id);
        return;
      }

      let resolvedAnime = anime;
      let serverEpisodes: Episode[] = [];
      const [apiResult, fbEpisodes] = await Promise.all([
        fetch(apiUrl(`/api/anime/${anime.id}`), { credentials: "include" })
          .then(async (res) => (res.ok ? res.json() : null))
          .catch(() => null),
        fetchAnimeEpisodesOnce(anime.id, isAdmin).catch(() => [] as Episode[]),
      ]);

      if (apiResult?.anime) resolvedAnime = apiResult.anime;
      if (Array.isArray(apiResult?.episodes)) serverEpisodes = apiResult.episodes;

      const resolvedEpisodes = mergeEpisodeLists(serverEpisodes, fbEpisodes);

      const mappedAnimeSources = (resolvedAnime.streamingSources || [])
        .filter((s) => Boolean(s?.url))
        .map((s) => ({
          label: s.name || `${s.quality || "1080p"} Stream`,
          url: s.url,
          quality: s.quality || "1080p",
          type: getStreamMimeType(s.url),
        }));

      const targetSeason = saved.season || 1;
      const matchedEpisode =
        resolvedEpisodes.find((e) => e.id === saved.episodeId) ||
        resolvedEpisodes.find(
          (e) =>
            e.number === saved.episodeNumber &&
            (e.season || 1) === targetSeason &&
            (!saved.language || !e.language || e.language === saved.language)
        ) ||
        resolvedEpisodes.find(
          (e) => e.number === saved.episodeNumber && (e.season || 1) === targetSeason
        ) ||
        resolvedEpisodes.find((e) => e.number === saved.episodeNumber);

      if (matchedEpisode) {
        const ownSources = Array.isArray(matchedEpisode.sources)
          ? matchedEpisode.sources.filter((s) => Boolean(s?.url?.trim()))
          : [];
        const fallbackUrl =
          matchedEpisode.videoUrl?.trim() || ownSources[0]?.url || mappedAnimeSources[0]?.url || "";
        startPlayback(resolvedAnime, {
          ...matchedEpisode,
          videoUrl: fallbackUrl,
          sources: ownSources.length > 0 ? ownSources : mappedAnimeSources,
        });
        return;
      }

      // Only synthesize a movie/single fallback if there are zero real episodes and Episode 1 was targeted
      if (
        resolvedEpisodes.length === 0 &&
        (saved.episodeNumber || 1) === 1 &&
        mappedAnimeSources.length > 0
      ) {
        startPlayback(resolvedAnime, {
          id: saved.episodeId || `ep-${resolvedAnime.id}-1`,
          animeId: resolvedAnime.id,
          number: 1,
          season: targetSeason,
          title: saved.episodeTitle || resolvedAnime.title || "Episode 1",
          language: saved.language || "Japanese",
          videoUrl: mappedAnimeSources[0].url,
          sources: mappedAnimeSources,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      navigateTo("details", resolvedAnime.id);
    },
    [isAdmin, navigateTo, startPlayback]
  );

  const contextValue = useMemo<AppContextType>(
    () => ({
      theme,
      setTheme,
      themeMode,
      setThemeMode,
      resolvedMode,
      themeSyncError,
      clearThemeSyncError,
      backgroundPoster,
      setBackgroundPoster,
      backgroundPosterUrl,
      safeMode,
      setSafeMode,
      soundEnabled,
      setSoundEnabled,
      soundPack,
      setSoundPack,
      isLockEnabled,
      isUnlocked,
      verifyPin,
      enableLock,
      disableLock,
      changePin,
      userId,
      authUser,
      isProfileSyncedToCloud,
      signInWithGoogle,
      signOutUser,
      profilePicture,
      setProfilePicture,
      displayName,
      setDisplayName,
      authReady,
      accessDeniedMessage,
      clearAccessDeniedMessage,
      adminToken,
      isAdmin,
      isFirebaseAdminAuthenticated,
      adminUser,
      getAdminAuthToken,
      loginAdmin,
      logoutAdmin,
      catalog,
      isLoadingCatalog,
      refreshCatalog,
      history,
      saveWatchProgress,
      clearHistory,
      favorites,
      toggleFavorite,
      watchlist,
      toggleWatchlist,
      currentView,
      navigateTo,
      goBack,
      selectedAnimeId,
      setSelectedAnimeId,
      activePlayingAnime,
      activePlayingEpisode,
      startPlayback,
      resumeAnimePlayback,
      closePlayback,
    }),
    [
      theme,
      setTheme,
      themeMode,
      setThemeMode,
      resolvedMode,
      themeSyncError,
      clearThemeSyncError,
      backgroundPoster,
      setBackgroundPoster,
      backgroundPosterUrl,
      safeMode,
      setSafeMode,
      soundEnabled,
      setSoundEnabled,
      soundPack,
      setSoundPack,
      isLockEnabled,
      isUnlocked,
      verifyPin,
      enableLock,
      disableLock,
      changePin,
      userId,
      authUser,
      isProfileSyncedToCloud,
      signInWithGoogle,
      signOutUser,
      profilePicture,
      setProfilePicture,
      displayName,
      setDisplayName,
      authReady,
      accessDeniedMessage,
      clearAccessDeniedMessage,
      adminToken,
      isAdmin,
      isFirebaseAdminAuthenticated,
      adminUser,
      getAdminAuthToken,
      loginAdmin,
      logoutAdmin,
      catalog,
      isLoadingCatalog,
      refreshCatalog,
      history,
      saveWatchProgress,
      clearHistory,
      favorites,
      toggleFavorite,
      watchlist,
      toggleWatchlist,
      currentView,
      navigateTo,
      goBack,
      selectedAnimeId,
      activePlayingAnime,
      activePlayingEpisode,
      startPlayback,
      resumeAnimePlayback,
      closePlayback,
    ]
  );

  return <AppContext.Provider value={contextValue}>{children}</AppContext.Provider>;
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
};
