import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dns from "dns";
import net from "net";
import { execFile } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import dotenv from "dotenv";
import multer from "multer";
import { createServer as createViteServer } from "vite";
import {
  initializeApp as initFirebaseAdminApp,
  getApps as getFirebaseAdminApps,
  getApp as getFirebaseAdminApp,
  cert as firebaseAdminCert,
} from "firebase-admin/app";
import { getAuth as getFirebaseAdminAuth, DecodedIdToken } from "firebase-admin/auth";

const execFileAsync = promisify(execFile);

dotenv.config();

const catalogEmitter = new EventEmitter();
catalogEmitter.setMaxListeners(500);

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "database.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

// Ensure directories exist & clean up stale partial uploads older than 6 hours
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
try {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const fname of fs.readdirSync(UPLOADS_DIR)) {
    if (fname.startsWith(".part_")) {
      const fpath = path.join(UPLOADS_DIR, fname);
      const st = fs.statSync(fpath);
      if (st.mtimeMs < cutoff) fs.unlinkSync(fpath);
    }
  }
} catch {}

// Body parsers
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// CORS support for Capacitor Android APK (https://localhost / capacitor://localhost) and Cloud Run origins
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin) {
    const allowedOrigin =
      origin === "https://localhost" ||
      origin === "http://localhost" ||
      origin.startsWith("http://localhost:") ||
      origin.startsWith("http://127.0.0.1") ||
      origin === "capacitor://localhost" ||
      /^https:\/\/[a-z0-9-]+\.run\.app$/i.test(origin) ||
      /^https:\/\/[a-z0-9-]+\.firebaseapp\.com$/i.test(origin);

    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With, Cache-Control, Pragma"
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }
  }
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Strict media & image extension allowlists (prevents .html / .svg / .js upload & stored XSS)
const SAFE_IMAGE_MIMES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const SAFE_MEDIA_UPLOAD_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif",
  ".mp4", ".mkv", ".webm", ".mov", ".m4v", ".ts", ".avi", ".3gp", ".flv", ".m3u8",
  ".vtt", ".srt",
]);
const SAFE_VIDEO_CHUNK_EXTS = new Set([
  ".mp4", ".mkv", ".webm", ".mov", ".m4v", ".ts", ".avi", ".3gp", ".flv",
]);

function isValidAvatarMagicBytes(buf: Buffer, ext: string): boolean {
  if (!buf || buf.length < 12) return false;
  if (ext === ".png") {
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  }
  if (ext === ".jpg") {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (ext === ".gif") {
    return buf.subarray(0, 4).toString("ascii") === "GIF8";
  }
  if (ext === ".webp") {
    return (
      buf.subarray(0, 4).toString("ascii") === "RIFF" &&
      buf.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

// File Upload config with Multer (admin media uploads)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const rawExt = path.extname(file.originalname).toLowerCase();
    const safeExt = SAFE_MEDIA_UPLOAD_EXTS.has(rawExt) ? rawExt : ".bin";
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    cb(null, `media-${uniqueSuffix}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max per file
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!SAFE_MEDIA_UPLOAD_EXTS.has(ext)) {
      return cb(new Error("Unsupported upload file type. Allowed: media, images, and subtitles."));
    }
    cb(null, true);
  },
});

// Memory-buffered upload for user avatars (validates auth + image bytes before writing to disk)
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // Up to 8MB per chunk cleanly via FormData
});

// Types
export interface AnimeCastMember {
  characterName: string;
  characterImage?: string;
  voiceActor: string;
  language?: string;
  role?: string;
}

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
  trending?: boolean;
  studio?: string;
  author?: string;
  director?: string;
  productionCompany?: string;
  cast?: AnimeCastMember[];
  streamingSources?: { name: string; url: string; quality?: string }[];
  createdAt: string;
  updatedAt: string;
}

export const VALID_EPISODE_LANGUAGES = [
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
  releaseDate?: string;
  bunnyVideoId?: string;
  videoUrl: string;
  thumbnailUrl?: string;
  order?: number;
  sources?: { label: string; url: string; quality: string; type: string }[];
  isPublished?: boolean;
  createdAt: string;
  updatedAt?: string;
}

function parseAgeRatingMinimumServer(rating?: string | null): number {
  const clean = String(rating || "").trim();
  if (!clean) return 13;
  const upper = clean.toUpperCase();
  if (upper === "G" || upper === "ALL AGES" || upper === "U") return 0;
  if (upper === "PG") return 7;
  if (upper === "PG-13") return 13;
  if (upper === "R17+" || upper === "R-17" || upper === "R") return 17;
  if (upper === "R18+" || upper === "NC-17" || upper === "ADULT") return 18;
  const match = clean.match(/\d+/);
  if (match) {
    const parsed = parseInt(match[0], 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 13;
}

function isRestrictedMatureRatingServer(rating?: string | null): boolean {
  const clean = String(rating || "").trim();
  if (!clean) return false;
  const upper = clean.toUpperCase();
  if (upper === "R17+" || upper === "R18+" || upper === "NC-17" || upper === "ADULT") {
    return true;
  }
  return parseAgeRatingMinimumServer(clean) >= 16;
}

function parseNonNegativeInt(raw: unknown, fallback: number, min = 0, max = 10000): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeQualityServer(raw?: unknown): string {
  const clean = String(raw || "").trim();
  if (!clean) return "1080p";
  const lower = clean.toLowerCase();
  if (lower.includes("2160") || lower === "4k" || lower.includes("uhd")) return "2160p";
  if (lower.includes("1440") || lower === "2k" || lower.includes("qhd")) return "1440p";
  if (lower.includes("1080") || lower === "fhd" || lower.includes("full hd")) return "1080p";
  if (lower.includes("720") || lower === "hd") return "720p";
  if (lower.includes("480") || lower === "sd") return "480p";
  if (lower.includes("360")) return "360p";
  return clean.slice(0, 24);
}

function qualityRankServer(q: string): number {
  switch (normalizeQualityServer(q)) {
    case "2160p": return 6;
    case "1440p": return 5;
    case "1080p": return 4;
    case "720p": return 3;
    case "480p": return 2;
    case "360p": return 1;
    default: return 0;
  }
}

function inferStreamMimeTypeServer(rawUrl?: string | null): string {
  const clean = String(rawUrl || "").trim();
  if (!clean) return "video/mp4";
  try {
    const parsed = new URL(clean, "https://ygflash.local");
    const host = parsed.hostname.toLowerCase();
    const pathLower = parsed.pathname.toLowerCase();
    const searchLower = parsed.search.toLowerCase();
    if (
      host === "youtu.be" ||
      host.endsWith("youtube.com") ||
      host.endsWith("youtube-nocookie.com")
    ) {
      return "video/youtube";
    }
    if (/(?:^|\.)vidmoly\.[a-z]{2,6}$/i.test(host) && !/\.(?:mp4|webm|mkv|mov)(\?|#|$)/i.test(pathLower) && !pathLower.endsWith(".m3u8")) {
      return "embed/vidmoly";
    }
    if (
      pathLower.endsWith(".m3u8") ||
      pathLower.includes(".m3u8/") ||
      searchLower.includes(".m3u8") ||
      parsed.searchParams.get("format")?.toLowerCase() === "m3u8"
    ) {
      return "application/x-mpegURL";
    }
  } catch {
    if (/\.m3u8(\?|#|$)/i.test(clean)) return "application/x-mpegURL";
  }
  return "video/mp4";
}

export interface ServerUserWatchHistoryItem {
  animeId: string;
  animeTitle: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  season?: number;
  language?: string;
  poster: string;
  progressSeconds: number;
  durationSeconds: number;
  updatedAt: number;
}

export interface ServerUserProfile {
  uid: string;
  authVerified?: boolean;
  pictureUrl?: string;
  displayName?: string;
  themeMode?: "dark" | "light" | "system";
  colorTheme?: "emerald" | "graphite" | "astral" | "ios";
  backgroundPoster?: "none" | "rengoku" | "luffy" | "mikey";
  safeMode?: boolean;
  soundEnabled?: boolean;
  soundPack?: "cyber" | "retro" | "soft";
  favorites?: string[];
  watchlist?: string[];
  watchHistory?: ServerUserWatchHistoryItem[];
  createdAt?: string;
  updatedAt?: string;
}

export interface DatabaseSchema {
  anime: Anime[];
  episodes: Episode[];
  adminSessionTokens: string[];
  userProfiles: Record<string, ServerUserProfile>;
  deletedAnimeIds?: string[];
}

// Clean initial catalog (no fake seeded streams or fake posters)
const INITIAL_ANIME: Anime[] = [];
const INITIAL_EPISODES: Episode[] = [];

// Read and write database helpers
function readDatabase(): DatabaseSchema {
  if (!fs.existsSync(DB_FILE)) {
    const initialData: DatabaseSchema = {
      anime: INITIAL_ANIME,
      episodes: INITIAL_EPISODES,
      adminSessionTokens: [],
      userProfiles: {},
      deletedAnimeIds: [],
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), "utf-8");
    return initialData;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const data: DatabaseSchema = JSON.parse(raw);
    if (!data.deletedAnimeIds) data.deletedAnimeIds = [];
    if (!data.anime) data.anime = [];
    if (!data.episodes) data.episodes = [];
    if (!data.userProfiles) data.userProfiles = {};

    // Filter out any anime or episodes that were marked deleted
    if (data.deletedAnimeIds.length > 0) {
      data.anime = data.anime.filter((a) => !data.deletedAnimeIds!.includes(a.id));
      data.episodes = data.episodes.filter((e) => !data.deletedAnimeIds!.includes(e.animeId));
    }
    return data;
  } catch (err) {
    console.error("Error reading database, creating fresh file:", err);
    const fallback: DatabaseSchema = {
      anime: INITIAL_ANIME,
      episodes: INITIAL_EPISODES,
      adminSessionTokens: [],
      userProfiles: {},
      deletedAnimeIds: [],
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(fallback, null, 2), "utf-8");
    return fallback;
  }
}

function writeDatabase(data: DatabaseSchema): void {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error("Failed to write database atomically:", err);
  }
}

// Ensure database is initialized
readDatabase();

// ==================== FIREBASE ADMIN SDK & STRICT OWNER AUTHORIZATION ====================
const AUTHORIZED_ADMIN_EMAIL = "xyronbhaiii@gmail.com";

function readFirebaseProjectConfig(): { projectId?: string; apiKey?: string } {
  try {
    const configPath = path.resolve(process.cwd(), "firebase-applet-config.json");
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) || {};
  } catch {
    return {};
  }
}

const fbAppletConfig = readFirebaseProjectConfig();
const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || fbAppletConfig.projectId || "";

function getOrInitFirebaseAdminAuth() {
  if (!getFirebaseAdminApps().length) {
    const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (saJson && saJson.trim().startsWith("{")) {
      try {
        const parsedSa = JSON.parse(saJson);
        initFirebaseAdminApp({
          credential: firebaseAdminCert(parsedSa),
          ...(FIREBASE_PROJECT_ID ? { projectId: FIREBASE_PROJECT_ID } : {}),
        });
      } catch (err) {
        console.warn("Invalid FIREBASE_SERVICE_ACCOUNT_JSON; falling back to projectId init:", err);
        initFirebaseAdminApp(FIREBASE_PROJECT_ID ? { projectId: FIREBASE_PROJECT_ID } : undefined);
      }
    } else {
      initFirebaseAdminApp(FIREBASE_PROJECT_ID ? { projectId: FIREBASE_PROJECT_ID } : undefined);
    }
  }
  return getFirebaseAdminAuth(getFirebaseAdminApp());
}

const firebaseAdminAuth = getOrInitFirebaseAdminAuth();

function parseRequestCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "string") return out;
  for (const part of raw.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

const ADMIN_SESSION_COOKIE = "yg_admin_session";

function extractBearerToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return "";
}

type VerifiedTokenOutcome =
  | { ok: true; decoded: DecodedIdToken }
  | { ok: false; code: "MISSING_AUTH_HEADER" | "TOKEN_EXPIRED" | "INVALID_TOKEN"; message: string };

async function verifyFirebaseIdTokenStrict(token: string): Promise<VerifiedTokenOutcome> {
  if (!token || token.split(".").length !== 3) {
    return {
      ok: false,
      code: "MISSING_AUTH_HEADER",
      message: "Unauthorized: Missing or invalid admin authorization header.",
    };
  }
  try {
    const decoded = await firebaseAdminAuth.verifyIdToken(token);
    if (!decoded?.uid) {
      return {
        ok: false,
        code: "INVALID_TOKEN",
        message: "Unauthorized: Invalid Firebase ID token.",
      };
    }
    return { ok: true, decoded };
  } catch (err: any) {
    const code = String(err?.code || "");
    if (code === "auth/id-token-expired" || /expired/i.test(String(err?.message || ""))) {
      return {
        ok: false,
        code: "TOKEN_EXPIRED",
        message: "Unauthorized: Firebase ID token expired. Refreshing token and retrying.",
      };
    }
    return {
      ok: false,
      code: "INVALID_TOKEN",
      message: "Unauthorized: Missing or invalid admin authorization header.",
    };
  }
}

function isAuthorizedAdminDecodedToken(decoded: DecodedIdToken): boolean {
  const email = String(decoded.email || "").trim().toLowerCase();
  const isOwnerEmail = email === AUTHORIZED_ADMIN_EMAIL.toLowerCase();
  const isEmailVerified = decoded.email_verified === true;
  const claimValue = (decoded as Record<string, unknown>).admin;
  // Strictly allow only verified owner email; if an admin claim is present on token it must be true
  const claimOk = claimValue === undefined || claimValue === true;
  return Boolean(decoded.uid && isOwnerEmail && isEmailVerified && claimOk);
}

async function syncAdminCustomClaimBestEffort(
  uid: string,
  shouldBeAdmin: boolean,
  existingClaim?: unknown
): Promise<{ synced: boolean; status: "synced" | "already-set" | "iam-required"; detail?: string }> {
  if (existingClaim === shouldBeAdmin) {
    return { synced: true, status: "already-set" };
  }
  try {
    await firebaseAdminAuth.setCustomUserClaims(uid, {
      admin: shouldBeAdmin,
      role: shouldBeAdmin ? "admin" : "user",
    });
    return { synced: true, status: "synced" };
  } catch (err: any) {
    return {
      synced: false,
      status: "iam-required",
      detail: err?.message || "Service account lacks roles/firebaseauth.admin IAM permission.",
    };
  }
}

async function isRequestVerifiedAdmin(req: Request): Promise<boolean> {
  const token = extractBearerToken(req);
  if (!token) return false;
  const outcome = await verifyFirebaseIdTokenStrict(token);
  if (!outcome.ok) return false;
  return isAuthorizedAdminDecodedToken(outcome.decoded);
}

async function verifyAdminAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: "Unauthorized: Missing or invalid admin authorization header.",
      code: "MISSING_AUTH_HEADER",
    });
  }

  const outcome = await verifyFirebaseIdTokenStrict(token);
  if (!outcome.ok) {
    return res.status(401).json({
      error: outcome.message,
      code: outcome.code,
    });
  }

  if (!isAuthorizedAdminDecodedToken(outcome.decoded)) {
    return res.status(403).json({
      error: `Access Denied: Account ${outcome.decoded.email || "unknown"} is not authorized for Admin operations.`,
      code: "ADMIN_FORBIDDEN",
    });
  }

  (req as Request & { adminUser?: DecodedIdToken }).adminUser = outcome.decoded;
  next();
}

// Serve uploaded files with range request support, safe MIME allowlist, and nosniff hardening
app.use("/uploads", express.static(UPLOADS_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".mkv") res.setHeader("Content-Type", "video/x-matroska");
    else if (ext === ".mp4" || ext === ".m4v") res.setHeader("Content-Type", "video/mp4");
    else if (ext === ".webm") res.setHeader("Content-Type", "video/webm");
    else if (ext === ".mov") res.setHeader("Content-Type", "video/quicktime");
    else if (ext === ".vtt") res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    else if (ext === ".srt") res.setHeader("Content-Type", "text/plain; charset=utf-8");
    else if (ext === ".m3u8") res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    else if (ext === ".ts") res.setHeader("Content-Type", "video/mp2t");
    else if (ext === ".jpg" || ext === ".jpeg") res.setHeader("Content-Type", "image/jpeg");
    else if (ext === ".png") res.setHeader("Content-Type", "image/png");
    else if (ext === ".webp") res.setHeader("Content-Type", "image/webp");
    else if (ext === ".gif") res.setHeader("Content-Type", "image/gif");
    else {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", "attachment");
    }
  }
}));

// ==================== HEALTH / NETWORK PING & REALTIME SSE ====================
app.get("/api/ping", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return res.json({ ok: true, ts: Date.now() });
});

app.get("/api/catalog-events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: "connected", ts: Date.now() })}\n\n`);

  const onUpdate = () => {
    res.write(`data: ${JSON.stringify({ type: "catalog-updated", ts: Date.now() })}\n\n`);
  };
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 20000);

  catalogEmitter.on("update", onUpdate);
  req.on("close", () => {
    clearInterval(heartbeat);
    catalogEmitter.off("update", onUpdate);
  });
});

// ==================== AUTH ROUTES (FIREBASE ID TOKEN + CUSTOM CLAIMS) ====================

// Verify Firebase user session, sync server-side custom claims (admin ONLY for xyronbhaiii@gmail.com)
app.post("/api/auth/session", async (req: Request, res: Response) => {
  const token =
    extractBearerToken(req) ||
    (typeof req.body?.idToken === "string" ? req.body.idToken.trim() : "") ||
    (typeof req.body?.firebaseIdToken === "string" ? req.body.firebaseIdToken.trim() : "");

  if (!token) {
    return res.status(401).json({
      authenticated: false,
      isAdmin: false,
      role: "guest",
      error: "Unauthorized: Missing Firebase ID token.",
    });
  }

  const outcome = await verifyFirebaseIdTokenStrict(token);
  if (!outcome.ok) {
    return res.status(401).json({
      authenticated: false,
      isAdmin: false,
      role: "guest",
      code: outcome.code,
      error: outcome.message,
    });
  }

  const decoded = outcome.decoded;
  const isOwnerEmail =
    String(decoded.email || "").trim().toLowerCase() === AUTHORIZED_ADMIN_EMAIL.toLowerCase() &&
    decoded.email_verified === true;
  const existingClaim = (decoded as Record<string, unknown>).admin;
  const claimSync = await syncAdminCustomClaimBestEffort(decoded.uid, isOwnerEmail, existingClaim);
  const isAdmin = isAuthorizedAdminDecodedToken(decoded);

  return res.json({
    authenticated: true,
    isAdmin,
    role: isAdmin ? "admin" : "user",
    user: {
      uid: decoded.uid,
      email: decoded.email || null,
      emailVerified: Boolean(decoded.email_verified),
      displayName: isAdmin ? "Authorized Admin Owner" : String(decoded.name || "Standard User"),
      adminClaim: existingClaim === true || (claimSync.synced && isAdmin),
    },
    claimSync,
  });
});

// Admin Login endpoint strictly requires verified Firebase ID token of xyronbhaiii@gmail.com (zero passkey bypass)
app.post("/api/auth/admin-login", async (req: Request, res: Response) => {
  const token =
    extractBearerToken(req) ||
    (typeof req.body?.firebaseIdToken === "string" ? req.body.firebaseIdToken.trim() : "") ||
    (typeof req.body?.idToken === "string" ? req.body.idToken.trim() : "");

  if (!token) {
    return res.status(401).json({
      authenticated: false,
      isAdmin: false,
      error: "Unauthorized: Missing or invalid admin authorization header.",
    });
  }

  const outcome = await verifyFirebaseIdTokenStrict(token);
  if (!outcome.ok) {
    return res.status(401).json({
      authenticated: false,
      isAdmin: false,
      code: outcome.code,
      error: outcome.message,
    });
  }

  const decoded = outcome.decoded;
  const isOwnerEmail =
    String(decoded.email || "").trim().toLowerCase() === AUTHORIZED_ADMIN_EMAIL.toLowerCase() &&
    decoded.email_verified === true;

  await syncAdminCustomClaimBestEffort(
    decoded.uid,
    isOwnerEmail,
    (decoded as Record<string, unknown>).admin
  );

  if (!isAuthorizedAdminDecodedToken(decoded)) {
    return res.status(403).json({
      authenticated: true,
      isAdmin: false,
      role: "user",
      error: `Access Denied: Only authorized owner Gmail (${AUTHORIZED_ADMIN_EMAIL}) has Admin privileges.`,
    });
  }

  return res.json({
    success: true,
    isAdmin: true,
    role: "admin",
    user: {
      uid: decoded.uid,
      email: decoded.email,
      displayName: "Authorized Admin Owner",
    },
  });
});

// Clear any legacy cookie on logout
app.post("/api/auth/admin-logout", (_req: Request, res: Response) => {
  res.clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
  return res.json({ success: true, message: "Signed out successfully." });
});

// Verify Current Bearer Token / Role
app.get("/api/auth/verify", async (req: Request, res: Response) => {
  const token = extractBearerToken(req);
  if (!token) {
    return res.json({ authenticated: false, isAdmin: false, role: "guest" });
  }
  const outcome = await verifyFirebaseIdTokenStrict(token);
  if (!outcome.ok) {
    return res.json({ authenticated: false, isAdmin: false, role: "guest", code: outcome.code });
  }
  const isAdmin = isAuthorizedAdminDecodedToken(outcome.decoded);
  return res.json({
    authenticated: true,
    isAdmin,
    role: isAdmin ? "admin" : "user",
    user: {
      uid: outcome.decoded.uid,
      email: outcome.decoded.email || null,
      displayName: isAdmin ? "Authorized Admin Owner" : String(outcome.decoded.name || "Standard User"),
    },
  });
});

// ==================== USER IDENTITY, PROFILE & PERSISTENT SETTINGS ====================

function resolveSafeUserId(raw: unknown, req?: Request): string {
  const fromRaw = typeof raw === "string" ? raw.trim() : "";
  const candidate =
    fromRaw ||
    (req ? parseRequestCookies(req)["yg_device_uid"] || "" : "");
  const clean = candidate.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
  return clean || "default_user";
}

function isGuestDeviceUid(uid: string): boolean {
  return (
    uid === "yg_server_default" ||
    uid === "default_user" ||
    /^yg_[a-z0-9]+_[a-z0-9]+$/i.test(uid)
  );
}

async function authorizeUserRequest(
  req: Request,
  targetUid: string,
  existingProfile?: ServerUserProfile
): Promise<{ ok: boolean; status: 200 | 401 | 403; verifiedBearer: boolean; error?: string }> {
  const authHeader = String(req.headers.authorization || "");
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (!token) {
      return { ok: false, status: 401, verifiedBearer: false, error: "Invalid authorization token." };
    }
    const outcome = await verifyFirebaseIdTokenStrict(token);
    if (!outcome.ok || outcome.decoded.uid !== targetUid) {
      return {
        ok: false,
        status: 403,
        verifiedBearer: false,
        error: "User token does not match requested account.",
      };
    }
    return { ok: true, status: 200, verifiedBearer: true };
  }

  // Without a Bearer token, only anonymous device guest UIDs (not linked to Firebase Auth) are allowed
  if (!isGuestDeviceUid(targetUid) || existingProfile?.authVerified === true) {
    return {
      ok: false,
      status: 401,
      verifiedBearer: false,
      error: "Authentication required for signed-in user accounts.",
    };
  }
  return { ok: true, status: 200, verifiedBearer: false };
}

function sanitizeProfileImageUrl(raw: unknown): string {
  const val = String(raw || "").trim();
  if (!val) return "";
  if (val.length > 500000) return "";
  if (
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(val) ||
    /^https?:\/\//i.test(val) ||
    val.startsWith("/uploads/")
  ) {
    return val;
  }
  return "";
}

function normalizeServerWatchHistory(
  rawList: unknown
): ServerUserWatchHistoryItem[] {
  if (!Array.isArray(rawList)) return [];
  const byAnime = new Map<string, ServerUserWatchHistoryItem>();
  for (const item of rawList) {
    if (!item || !item.animeId || !item.episodeId) continue;
    const animeId = String(item.animeId);
    const updatedAt = Number(item.updatedAt) || 0;
    const existing = byAnime.get(animeId);
    if (!existing || updatedAt > (existing.updatedAt || 0)) {
      byAnime.set(animeId, {
        animeId,
        animeTitle: String(item.animeTitle || "Anime").slice(0, 200),
        episodeId: String(item.episodeId),
        episodeNumber: Math.max(0, Math.round(Number(item.episodeNumber) || 1)),
        episodeTitle: String(item.episodeTitle || `Episode ${item.episodeNumber || 1}`).slice(0, 200),
        season: Math.max(1, Math.round(Number(item.season) || 1)),
        language: String(item.language || "Japanese").slice(0, 40),
        poster: String(item.poster || "").slice(0, 500000),
        progressSeconds: Math.max(0, Number(item.progressSeconds) || 0),
        durationSeconds: Math.max(0, Number(item.durationSeconds) || 0),
        updatedAt,
      });
    }
  }
  return Array.from(byAnime.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 30);
}

app.post("/api/user/profile-picture", avatarUpload.single("picture"), async (req: Request, res: Response) => {
  try {
    const userId = resolveSafeUserId(req.body?.userId, req);
    const db = readDatabase();
    if (!db.userProfiles) db.userProfiles = {};
    const existing = db.userProfiles[userId];

    const authCheck = await authorizeUserRequest(req, userId, existing);
    if (!authCheck.ok) {
      return res.status(authCheck.status).json({ error: authCheck.error });
    }

    const { pictureBase64 } = req.body;
    let pictureUrl = "";
    if (req.file) {
      const ext = SAFE_IMAGE_MIMES[String(req.file.mimetype || "").toLowerCase()];
      if (!ext || !isValidAvatarMagicBytes(req.file.buffer, ext)) {
        return res.status(400).json({ error: "Invalid image file. Only PNG, JPEG, WebP, or GIF photos are supported." });
      }
      const filename = `avatar-${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
      await fs.promises.writeFile(path.join(UPLOADS_DIR, filename), req.file.buffer);
      pictureUrl = `/uploads/${filename}`;
    } else if (pictureBase64 && typeof pictureBase64 === "string") {
      pictureUrl = sanitizeProfileImageUrl(pictureBase64);
      if (!pictureUrl) {
        return res.status(400).json({ error: "Invalid image format or image exceeds 500KB limit." });
      }
    }

    if (!pictureUrl) {
      return res.status(400).json({ error: "No picture file or image data provided." });
    }

    const nowIso = new Date().toISOString();
    db.userProfiles[userId] = {
      ...existing,
      uid: userId,
      ...(authCheck.verifiedBearer ? { authVerified: true } : {}),
      pictureUrl,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    writeDatabase(db);

    return res.json({ success: true, userId, pictureUrl });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to save profile picture." });
  }
});

app.delete("/api/user/profile-picture", async (req: Request, res: Response) => {
  const userId = resolveSafeUserId(req.body?.userId || req.query?.userId, req);
  const db = readDatabase();
  const existing = db.userProfiles?.[userId];
  const authCheck = await authorizeUserRequest(req, userId, existing);
  if (!authCheck.ok) {
    return res.status(authCheck.status).json({ error: authCheck.error });
  }
  if (db.userProfiles && db.userProfiles[userId]) {
    delete db.userProfiles[userId].pictureUrl;
    if (authCheck.verifiedBearer) db.userProfiles[userId].authVerified = true;
    db.userProfiles[userId].updatedAt = new Date().toISOString();
    writeDatabase(db);
  }
  return res.json({ success: true });
});

// Update Custom Username
app.post("/api/user/username", async (req: Request, res: Response) => {
  try {
    const userId = resolveSafeUserId(req.body?.userId, req);
    const db = readDatabase();
    if (!db.userProfiles) db.userProfiles = {};
    const existing = db.userProfiles[userId];
    const authCheck = await authorizeUserRequest(req, userId, existing);
    if (!authCheck.ok) {
      return res.status(authCheck.status).json({ error: authCheck.error });
    }
    const { displayName } = req.body;
    if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
      return res.status(400).json({ error: "Username cannot be empty." });
    }
    const cleanName = displayName.trim().slice(0, 32);
    const nowIso = new Date().toISOString();
    db.userProfiles[userId] = {
      ...existing,
      uid: userId,
      ...(authCheck.verifiedBearer ? { authVerified: true } : {}),
      displayName: cleanName,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    writeDatabase(db);
    return res.json({ success: true, userId, displayName: cleanName });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to update username." });
  }
});

// Sync Full User Settings, Theme, Favorites, Watchlist & Profile
app.post("/api/user/profile", async (req: Request, res: Response) => {
  try {
    const userId = resolveSafeUserId(req.body?.userId || req.body?.uid, req);
    const db = readDatabase();
    if (!db.userProfiles) db.userProfiles = {};
    const existing = db.userProfiles[userId];
    const authCheck = await authorizeUserRequest(req, userId, existing);
    if (!authCheck.ok) {
      return res.status(authCheck.status).json({ error: authCheck.error });
    }
    const nowIso = new Date().toISOString();

    const nextProfile: ServerUserProfile = {
      ...existing,
      uid: userId,
      ...(authCheck.verifiedBearer ? { authVerified: true } : {}),
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    if (typeof req.body?.displayName === "string" && req.body.displayName.trim()) {
      nextProfile.displayName = req.body.displayName.trim().slice(0, 32);
    }
    if (req.body?.pictureUrl !== undefined) {
      const safeUrl = sanitizeProfileImageUrl(req.body.pictureUrl);
      nextProfile.pictureUrl = safeUrl;
    }
    if (["dark", "light", "system"].includes(req.body?.themeMode)) {
      nextProfile.themeMode = req.body.themeMode;
    }
    if (req.body?.colorTheme === "crimson") {
      nextProfile.colorTheme = "emerald";
    } else if (["emerald", "graphite", "astral", "ios"].includes(req.body?.colorTheme)) {
      nextProfile.colorTheme = req.body.colorTheme;
    }
    if (["none", "rengoku", "luffy", "mikey"].includes(req.body?.backgroundPoster)) {
      nextProfile.backgroundPoster = req.body.backgroundPoster;
    }
    if (typeof req.body?.safeMode === "boolean") {
      nextProfile.safeMode = req.body.safeMode;
    }
    if (typeof req.body?.soundEnabled === "boolean") {
      nextProfile.soundEnabled = req.body.soundEnabled;
    }
    if (["cyber", "retro", "soft"].includes(req.body?.soundPack)) {
      nextProfile.soundPack = req.body.soundPack;
    }
    if (Array.isArray(req.body?.favorites)) {
      nextProfile.favorites = Array.from(
        new Set<string>(req.body.favorites.map((x: unknown) => String(x || "").trim()).filter(Boolean))
      ).slice(0, 200);
    }
    if (Array.isArray(req.body?.watchlist)) {
      nextProfile.watchlist = Array.from(
        new Set<string>(req.body.watchlist.map((x: unknown) => String(x || "").trim()).filter(Boolean))
      ).slice(0, 200);
    }
    if (Array.isArray(nextProfile.watchHistory)) {
      nextProfile.watchHistory = normalizeServerWatchHistory(nextProfile.watchHistory);
    }

    db.userProfiles[userId] = nextProfile;
    writeDatabase(db);
    return res.json({ success: true, userId, profile: nextProfile });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to save user profile." });
  }
});

// Persist Watch History Item per UID (strictly 1 latest entry per animeId)
app.post("/api/user/watch-history", async (req: Request, res: Response) => {
  try {
    const userId = resolveSafeUserId(req.body?.userId || req.body?.uid, req);
    const db = readDatabase();
    if (!db.userProfiles) db.userProfiles = {};
    const existing = db.userProfiles[userId];
    const authCheck = await authorizeUserRequest(req, userId, existing);
    if (!authCheck.ok) {
      return res.status(authCheck.status).json({ error: authCheck.error });
    }
    const item = req.body?.item;
    if (!item || !item.animeId || !item.episodeId) {
      return res.status(400).json({ error: "animeId and episodeId are required." });
    }
    const existingProfile = existing || { uid: userId };
    const nowIso = new Date().toISOString();
    const prevList = normalizeServerWatchHistory(existingProfile.watchHistory);
    const entry: ServerUserWatchHistoryItem = {
      animeId: String(item.animeId),
      animeTitle: String(item.animeTitle || "Anime").slice(0, 200),
      episodeId: String(item.episodeId),
      episodeNumber: Math.max(0, Math.round(Number(item.episodeNumber) || 1)),
      episodeTitle: String(item.episodeTitle || `Episode ${item.episodeNumber || 1}`).slice(0, 200),
      season: Math.max(1, Math.round(Number(item.season) || 1)),
      language: String(item.language || "Japanese").slice(0, 40),
      poster: String(item.poster || "").slice(0, 500000),
      progressSeconds: Math.max(0, Number(item.progressSeconds) || 0),
      durationSeconds: Math.max(0, Number(item.durationSeconds) || 0),
      updatedAt: Date.now(),
    };
    const nextHistory = [
      entry,
      ...prevList.filter((h) => h.animeId !== entry.animeId),
    ].slice(0, 30);

    db.userProfiles[userId] = {
      ...existingProfile,
      uid: userId,
      ...(authCheck.verifiedBearer ? { authVerified: true } : {}),
      watchHistory: nextHistory,
      createdAt: existingProfile.createdAt || nowIso,
      updatedAt: nowIso,
    };
    writeDatabase(db);
    return res.json({ success: true, watchHistory: nextHistory });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to save watch history." });
  }
});

app.delete("/api/user/watch-history", async (req: Request, res: Response) => {
  const userId = resolveSafeUserId(req.body?.userId || req.query?.userId, req);
  const db = readDatabase();
  const existing = db.userProfiles?.[userId];
  const authCheck = await authorizeUserRequest(req, userId, existing);
  if (!authCheck.ok) {
    return res.status(authCheck.status).json({ error: authCheck.error });
  }
  if (db.userProfiles && db.userProfiles[userId]) {
    db.userProfiles[userId].watchHistory = [];
    if (authCheck.verifiedBearer) db.userProfiles[userId].authVerified = true;
    db.userProfiles[userId].updatedAt = new Date().toISOString();
    writeDatabase(db);
  }
  return res.json({ success: true });
});

// Retrieve User Profile (automatically normalizes legacy duplicate watchHistory/favorites/watchlist)
app.get("/api/user/profile", async (req: Request, res: Response) => {
  const userId = resolveSafeUserId(req.query?.userId, req);
  const db = readDatabase();
  const rawProfile = db.userProfiles?.[userId];
  const authCheck = await authorizeUserRequest(req, userId, rawProfile);
  if (!authCheck.ok) {
    return res.status(authCheck.status).json({ error: authCheck.error });
  }
  const profile: ServerUserProfile = rawProfile
    ? {
        ...rawProfile,
        ...(rawProfile.colorTheme && (rawProfile.colorTheme as string) === "crimson"
          ? { colorTheme: "emerald" }
          : {}),
        ...(Array.isArray(rawProfile.favorites)
          ? {
              favorites: Array.from(
                new Set(rawProfile.favorites.map((x) => String(x || "").trim()).filter(Boolean))
              ),
            }
          : {}),
        ...(Array.isArray(rawProfile.watchlist)
          ? {
              watchlist: Array.from(
                new Set(rawProfile.watchlist.map((x) => String(x || "").trim()).filter(Boolean))
              ),
            }
          : {}),
        ...(Array.isArray(rawProfile.watchHistory)
          ? { watchHistory: normalizeServerWatchHistory(rawProfile.watchHistory) }
          : {}),
      }
    : { uid: userId };
  return res.json({ success: true, userId, profile });
});

// ==================== PUBLIC ANIME ROUTES ====================

// List Anime with Safe Mode, Search, & Genre filter
app.get("/api/anime", async (req: Request, res: Response) => {
  const db = readDatabase();
  const { query, genre, safeMode = "true", includeUnpublished } = req.query;

  // Check if requester holds verified admin Bearer token
  const isAdmin = await isRequestVerifiedAdmin(req);

  let list = db.anime;

  // Filter unpublished anime unless admin explicitly requests all
  if (!isAdmin || includeUnpublished !== "true") {
    list = list.filter((a) => a.isPublished);
  }

  // Safe Mode Content Safety Enforcement (Backend restriction: hides 16+, 18+, R17+, R18+)
  if (safeMode === "true" || safeMode === undefined) {
    list = list.filter((a) => !isRestrictedMatureRatingServer(a.rating));
  }

  // Search filter
  if (query && typeof query === "string" && query.trim()) {
    const q = query.trim().toLowerCase();
    list = list.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        (a.titleJapanese && a.titleJapanese.toLowerCase().includes(q)) ||
        a.synopsis.toLowerCase().includes(q) ||
        a.genres.some((g) => g.toLowerCase().includes(q))
    );
  }

  // Genre filter
  if (genre && typeof genre === "string" && genre !== "All") {
    list = list.filter((a) => a.genres.includes(genre));
  }

  return res.json({
    anime: list,
    total: list.length,
    deletedAnimeIds: db.deletedAnimeIds || [],
  });
});

// Get Anime Details & Episodes
app.get("/api/anime/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const db = readDatabase();

  const anime = db.anime.find((a) => a.id === id);
  if (!anime) {
    return res.status(404).json({ error: "Anime not found." });
  }

  const requesterIsAdmin = await isRequestVerifiedAdmin(req);

  // Check admin privileges for unpublished content
  if (!anime.isPublished && !requesterIsAdmin) {
    return res.status(404).json({ error: "Anime is not published." });
  }

  const episodes = db.episodes
    .filter((e) => e.animeId === id && (requesterIsAdmin || e.isPublished !== false))
    .map((e) => ({
      ...e,
      season: Math.max(1, Number(e.season) || 1),
      language: e.language || "Japanese",
      description: e.description ?? e.synopsis ?? "",
      isPublished: e.isPublished !== false,
      order: e.order !== undefined ? e.order : e.number,
    }))
    .sort((a, b) => {
      const seasonDiff = (a.season || 1) - (b.season || 1);
      if (seasonDiff !== 0) return seasonDiff;
      const orderDiff = (a.order ?? a.number) - (b.order ?? b.number);
      if (orderDiff !== 0) return orderDiff;
      const numDiff = a.number - b.number;
      if (numDiff !== 0) return numDiff;
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    });

  return res.json({ anime, episodes });
});

// ==================== ADMIN DASHBOARD ROUTES ====================

function sanitizeCastServer(rawList: unknown): AnimeCastMember[] {
  if (!Array.isArray(rawList)) return [];
  const out: AnimeCastMember[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const characterName = String((item as any).characterName || "").trim().slice(0, 160);
    const voiceActor = String((item as any).voiceActor || "").trim().slice(0, 160);
    if (!characterName && !voiceActor) continue;
    let characterImage = String((item as any).characterImage || "").trim().slice(0, 2048);
    if (characterImage && !/^https?:\/\//i.test(characterImage)) characterImage = "";
    const language = String((item as any).language || "").trim().slice(0, 64);
    const role = String((item as any).role || "").trim().slice(0, 64);
    out.push({
      characterName: characterName || "Character",
      voiceActor: voiceActor || "Uncredited",
      ...(characterImage ? { characterImage } : {}),
      ...(language ? { language } : {}),
      ...(role ? { role } : {}),
    });
    if (out.length >= 30) break;
  }
  return out;
}

// Add Anime (Admin only)
app.post("/api/admin/anime", verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const {
      id,
      title,
      titleJapanese = "",
      synopsis,
      posterImage,
      bannerImage,
      genres = [],
      rating = "13+",
      ratingVerified,
      status = "Ongoing",
      year = new Date().getFullYear(),
      seasons = 1,
      episodesCount,
      isPublished = true,
      featured,
      trending,
      studio = "",
      author = "",
      director = "",
      productionCompany = "",
      cast = [],
      streamingSources = [],
    } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "Anime title is required." });
    }

    const cleanRating = String(rating || "").trim();
    if (!cleanRating || cleanRating.length > 32) {
      return res.status(400).json({ error: "A valid Age Rating (1-32 chars) is required." });
    }

    const db = readDatabase();
    const cleanTitle = String(title).trim();
    const resolvedSynopsis =
      String(synopsis || "").trim() || `Stream ${cleanTitle} in high speed on YG Flash Anime.`;
    const normalizedTitle = cleanTitle.toLowerCase();
    const incomingSources = (Array.isArray(streamingSources) ? streamingSources : [])
      .filter((s: any) => s?.url && isValidStreamOrMediaUrl(String(s.url)))
      .map((s: any) => ({
        name: String(s.name || s.quality || "Stream").trim(),
        url: String(s.url).trim(),
        quality: normalizeQualityServer(s.quality || s.name),
      }))
      .sort((a, b) => qualityRankServer(b.quality) - qualityRankServer(a.quality));

    const cleanStudio = String(studio || "").trim().slice(0, 200);
    const cleanAuthor = String(author || "").trim().slice(0, 200);
    const cleanDirector = String(director || "").trim().slice(0, 200);
    const cleanProdCompany = String(productionCompany || "").trim().slice(0, 200);
    const cleanCast = sanitizeCastServer(cast);

    // Check if an anime with this exact ID or exact title already exists so different qualities save onto that same anime
    const existingById = typeof id === "string" && id.trim() ? db.anime.find((a) => a.id === id.trim()) : undefined;
    const existingByTitle = !existingById ? db.anime.find((a) => a.title.trim().toLowerCase() === normalizedTitle) : undefined;
    const existingTarget = existingById || existingByTitle;

    if (existingTarget) {
      const mergedMap = new Map<string, { name: string; url: string; quality?: string }>();
      for (const s of existingTarget.streamingSources || []) {
        if (s?.url) {
          const normQ = normalizeQualityServer(s.quality || s.name);
          mergedMap.set(normQ.toLowerCase(), { ...s, quality: normQ });
        }
      }
      for (const s of incomingSources) {
        if (s?.url) {
          mergedMap.set(s.quality.toLowerCase(), s);
        }
      }

      const mergedSourcesList = Array.from(mergedMap.values()).sort(
        (a, b) => qualityRankServer(b.quality || "") - qualityRankServer(a.quality || "")
      );
      const resolvedEpCount = parseNonNegativeInt(episodesCount, existingTarget.episodesCount);
      const updatedAnime: Anime = {
        ...existingTarget,
        title: cleanTitle || existingTarget.title,
        titleJapanese: String(titleJapanese).trim() || existingTarget.titleJapanese,
        synopsis: String(synopsis || "").trim() || existingTarget.synopsis,
        posterImage: posterImage || existingTarget.posterImage,
        bannerImage: bannerImage || existingTarget.bannerImage || posterImage || existingTarget.posterImage,
        genres: Array.isArray(genres) && genres.length > 0 ? genres : existingTarget.genres,
        rating: cleanRating || existingTarget.rating,
        ratingVerified:
          typeof ratingVerified === "boolean" ? ratingVerified : existingTarget.ratingVerified,
        status: status === "Completed" ? "Completed" : existingTarget.status,
        year: parseNonNegativeInt(year, existingTarget.year, 1950, 2100),
        seasons: parseNonNegativeInt(seasons, existingTarget.seasons || 1, 1, 200),
        episodesCount: resolvedEpCount,
        isPublished: typeof isPublished === "boolean" ? isPublished : existingTarget.isPublished,
        featured: typeof featured === "boolean" ? featured : existingTarget.featured,
        trending: typeof trending === "boolean" ? trending : existingTarget.trending,
        studio: cleanStudio || existingTarget.studio,
        author: cleanAuthor || existingTarget.author,
        director: cleanDirector || existingTarget.director,
        productionCompany: cleanProdCompany || existingTarget.productionCompany,
        cast: cleanCast.length > 0 ? cleanCast : existingTarget.cast,
        streamingSources: mergedSourcesList,
        updatedAt: new Date().toISOString(),
      };

      db.anime = db.anime.map((a) => (a.id === existingTarget.id ? updatedAnime : a));

      // Auto-sync Episode 1 if anime has streamable sources and 0 episodes (unless explicitly marked 0-episode series without sources)
      const hasAnyEps = db.episodes.some((ep) => ep.animeId === updatedAnime.id);
      if (!hasAnyEps && mergedSourcesList.length > 0) {
        const epSources = mergedSourcesList.map((s) => ({
          label: s.name || `${s.quality || "1080p"} Stream`,
          url: s.url,
          quality: normalizeQualityServer(s.quality),
          type: inferStreamMimeTypeServer(s.url),
        }));
        db.episodes.push({
          id: `ep-${updatedAnime.id}-1`,
          animeId: updatedAnime.id,
          number: 1,
          season: 1,
          title: "Episode 1",
          language: "Japanese",
          duration: "24m",
          videoUrl: epSources.find((s) => s.quality === "1080p")?.url || epSources[0].url,
          sources: epSources,
          createdAt: new Date().toISOString(),
        });
      }

      writeDatabase(db);
      catalogEmitter.emit("update");

      return res.status(200).json({ success: true, anime: updatedAnime, mergedExisting: true });
    }

    const resolvedId =
      typeof id === "string" && id.trim()
        ? id.trim()
        : `anime-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const resolvedNewEpCount = parseNonNegativeInt(episodesCount, 0);

    const newAnime: Anime = {
      id: resolvedId,
      title: cleanTitle,
      titleJapanese: String(titleJapanese).trim(),
      synopsis: resolvedSynopsis,
      posterImage: posterImage || "",
      bannerImage: bannerImage || posterImage || "",
      genres: Array.isArray(genres) ? genres : [genres],
      rating: cleanRating,
      ratingVerified: typeof ratingVerified === "boolean" ? ratingVerified : true,
      status: status === "Completed" ? "Completed" : "Ongoing",
      year: parseNonNegativeInt(year, new Date().getFullYear(), 1950, 2100),
      seasons: parseNonNegativeInt(seasons, 1, 1, 200),
      episodesCount: resolvedNewEpCount,
      isPublished: Boolean(isPublished),
      featured: Boolean(featured),
      trending: Boolean(trending),
      ...(cleanStudio ? { studio: cleanStudio } : {}),
      ...(cleanAuthor ? { author: cleanAuthor } : {}),
      ...(cleanDirector ? { director: cleanDirector } : {}),
      ...(cleanProdCompany ? { productionCompany: cleanProdCompany } : {}),
      ...(cleanCast.length > 0 ? { cast: cleanCast } : {}),
      streamingSources: incomingSources,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    db.anime.unshift(newAnime);

    // Auto-create Episode 1 when anime is published with gallery/stream video so every user can watch instantly
    if (incomingSources.length > 0 && !db.episodes.some((ep) => ep.animeId === resolvedId)) {
      const epSources = incomingSources.map((s) => ({
        label: s.name || `${s.quality || "1080p"} Stream`,
        url: s.url,
        quality: normalizeQualityServer(s.quality),
        type: inferStreamMimeTypeServer(s.url),
      }));
      if (epSources.length > 0) {
        db.episodes.push({
          id: `ep-${resolvedId}-1`,
          animeId: resolvedId,
          number: 1,
          season: 1,
          title: "Episode 1",
          language: "Japanese",
          duration: "24m",
          videoUrl: epSources.find((s) => s.quality === "1080p")?.url || epSources[0].url,
          sources: epSources,
          createdAt: new Date().toISOString(),
        });
      }
    }

    writeDatabase(db);
    catalogEmitter.emit("update");

    return res.status(201).json({ success: true, anime: newAnime });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to create anime." });
  }
});

// Edit Anime (Admin only)
app.put("/api/admin/anime/:id", verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = readDatabase();
    const index = db.anime.findIndex((a) => a.id === id);

    const normalizeIncomingSources = (rawList: any) =>
      (Array.isArray(rawList) ? rawList : [])
        .filter((s: any) => s?.url && isValidStreamOrMediaUrl(String(s.url)))
        .map((s: any) => ({
          name: String(s.name || s.quality || "Stream").trim(),
          url: String(s.url).trim(),
          quality: normalizeQualityServer(s.quality || s.name),
        }))
        .sort((a, b) => qualityRankServer(b.quality) - qualityRankServer(a.quality));

    const cleanStudio =
      req.body?.studio !== undefined ? String(req.body.studio || "").trim().slice(0, 200) : undefined;
    const cleanAuthor =
      req.body?.author !== undefined ? String(req.body.author || "").trim().slice(0, 200) : undefined;
    const cleanDirector =
      req.body?.director !== undefined ? String(req.body.director || "").trim().slice(0, 200) : undefined;
    const cleanProdCompany =
      req.body?.productionCompany !== undefined
        ? String(req.body.productionCompany || "").trim().slice(0, 200)
        : undefined;
    const cleanCast =
      req.body?.cast !== undefined ? sanitizeCastServer(req.body.cast) : undefined;

    if (index === -1) {
      // Upsert seamlessly if record was synced from Firebase (explicitly whitelist fields)
      const upsertedTitle = String(req.body?.title || "").trim().slice(0, 200);
      if (!upsertedTitle) {
        return res.status(400).json({ error: "Anime title is required." });
      }
      const cleanRating = String(req.body?.rating || "13+").trim().slice(0, 32) || "13+";
      const upserted: Anime = {
        id,
        title: upsertedTitle,
        titleJapanese: String(req.body?.titleJapanese || "").trim().slice(0, 200),
        synopsis: String(req.body?.synopsis || `Stream ${upsertedTitle} in HD.`).trim().slice(0, 5000),
        posterImage: String(req.body?.posterImage || "").trim(),
        bannerImage: String(req.body?.bannerImage || req.body?.posterImage || "").trim(),
        genres: Array.isArray(req.body?.genres)
          ? req.body.genres.map((g: unknown) => String(g || "").trim()).filter(Boolean).slice(0, 20)
          : [],
        rating: cleanRating,
        ratingVerified: typeof req.body?.ratingVerified === "boolean" ? req.body.ratingVerified : true,
        status: req.body?.status === "Completed" ? "Completed" : "Ongoing",
        year: parseNonNegativeInt(req.body?.year, new Date().getFullYear(), 1950, 2100),
        seasons: parseNonNegativeInt(req.body?.seasons, 1, 1, 200),
        episodesCount: parseNonNegativeInt(req.body?.episodesCount, 0, 0, 10000),
        isPublished: req.body?.isPublished !== false,
        featured: Boolean(req.body?.featured),
        trending: Boolean(req.body?.trending),
        ...(cleanStudio ? { studio: cleanStudio } : {}),
        ...(cleanAuthor ? { author: cleanAuthor } : {}),
        ...(cleanDirector ? { director: cleanDirector } : {}),
        ...(cleanProdCompany ? { productionCompany: cleanProdCompany } : {}),
        ...(cleanCast && cleanCast.length > 0 ? { cast: cleanCast } : {}),
        streamingSources: normalizeIncomingSources(req.body?.streamingSources),
        createdAt: typeof req.body?.createdAt === "string" && req.body.createdAt.trim()
          ? req.body.createdAt.trim()
          : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.anime.unshift(upserted);
      writeDatabase(db);
      catalogEmitter.emit("update");
      return res.json({ success: true, anime: upserted });
    }

    const current = db.anime[index];
    const cleanRating =
      req.body?.rating !== undefined
        ? String(req.body.rating).trim().slice(0, 32) || current.rating
        : current.rating;

    const updated: Anime = {
      ...current,
      id: current.id, // prevent ID overwrite
      title:
        typeof req.body?.title === "string" && req.body.title.trim()
          ? req.body.title.trim().slice(0, 200)
          : current.title,
      titleJapanese:
        typeof req.body?.titleJapanese === "string"
          ? req.body.titleJapanese.trim().slice(0, 200)
          : current.titleJapanese,
      synopsis:
        typeof req.body?.synopsis === "string"
          ? req.body.synopsis.trim().slice(0, 5000)
          : current.synopsis,
      posterImage:
        typeof req.body?.posterImage === "string" ? req.body.posterImage.trim() : current.posterImage,
      bannerImage:
        typeof req.body?.bannerImage === "string" ? req.body.bannerImage.trim() : current.bannerImage,
      genres: Array.isArray(req.body?.genres)
        ? req.body.genres.map((g: unknown) => String(g || "").trim()).filter(Boolean).slice(0, 20)
        : current.genres,
      status:
        req.body?.status === "Completed" || req.body?.status === "Ongoing"
          ? req.body.status
          : current.status,
      isPublished:
        typeof req.body?.isPublished === "boolean" ? req.body.isPublished : current.isPublished,
      featured:
        typeof req.body?.featured === "boolean" ? req.body.featured : current.featured,
      rating: cleanRating,
      ratingVerified:
        typeof req.body?.ratingVerified === "boolean"
          ? req.body.ratingVerified
          : current.ratingVerified,
      trending:
        req.body?.trending !== undefined ? Boolean(req.body.trending) : current.trending,
      studio: cleanStudio !== undefined ? cleanStudio || undefined : current.studio,
      author: cleanAuthor !== undefined ? cleanAuthor || undefined : current.author,
      director: cleanDirector !== undefined ? cleanDirector || undefined : current.director,
      productionCompany:
        cleanProdCompany !== undefined ? cleanProdCompany || undefined : current.productionCompany,
      cast: cleanCast !== undefined ? cleanCast : current.cast,
      seasons: parseNonNegativeInt(req.body?.seasons, current.seasons || 1, 1, 200),
      episodesCount: parseNonNegativeInt(req.body?.episodesCount, current.episodesCount ?? 0, 0, 10000),
      year: parseNonNegativeInt(req.body?.year, current.year, 1950, 2100),
      streamingSources:
        req.body?.streamingSources !== undefined
          ? normalizeIncomingSources(req.body.streamingSources)
          : current.streamingSources,
      updatedAt: new Date().toISOString(),
    };

    db.anime[index] = updated;

    // Keep all episodes belonging to this anime aligned with its publish status
    if (req.body?.isPublished !== undefined) {
      const nextPublished = Boolean(updated.isPublished);
      const syncTs = new Date().toISOString();
      db.episodes = db.episodes.map((ep) =>
        ep.animeId === updated.id
          ? { ...ep, isPublished: nextPublished, updatedAt: syncTs }
          : ep
      );
    }

    // Auto-sync Episode 1 if anime has streamable sources and 0 episodes so every user can watch immediately
    const sourcesList = Array.isArray(updated.streamingSources) ? updated.streamingSources : [];
    if (sourcesList.length > 0 && !db.episodes.some((ep) => ep.animeId === updated.id)) {
      const epSources = sourcesList
        .filter((s) => Boolean(s?.url))
        .map((s) => ({
          label: s.name || `${s.quality || "1080p"} Stream`,
          url: s.url,
          quality: normalizeQualityServer(s.quality),
          type: inferStreamMimeTypeServer(s.url),
        }));
      if (epSources.length > 0) {
        db.episodes.push({
          id: `ep-${updated.id}-1`,
          animeId: updated.id,
          number: 1,
          season: 1,
          title: "Episode 1",
          language: "Japanese",
          duration: "24m",
          videoUrl: epSources.find((s) => s.quality === "1080p")?.url || epSources[0].url,
          sources: epSources,
          isPublished: Boolean(updated.isPublished),
          createdAt: new Date().toISOString(),
        });
      }
    }

    writeDatabase(db);
    catalogEmitter.emit("update");

    return res.json({ success: true, anime: updated });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to update anime." });
  }
});

app.delete("/api/admin/anime/:id", verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;
    if (!rawId) {
      return res.status(400).json({ error: "Missing anime ID." });
    }
    const id = rawId.trim();
    const db = readDatabase();

    db.anime = db.anime.filter((a) => a.id.trim() !== id);
    db.episodes = db.episodes.filter((e) => e.animeId.trim() !== id);

    if (!db.deletedAnimeIds) db.deletedAnimeIds = [];
    if (!db.deletedAnimeIds.includes(id)) {
      db.deletedAnimeIds.push(id);
    }

    writeDatabase(db);
    catalogEmitter.emit("update");
    return res.json({ success: true, message: `Anime ${id} deleted permanently.`, deletedId: id });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to delete anime." });
  }
});

function isValidStreamOrMediaUrl(raw: string): boolean {
  const trimmed = String(raw || "").trim();
  if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) return false;
  if (trimmed.startsWith("/uploads/")) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidOptionalThumbUrl(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  const trimmed = String(raw).trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("/uploads/") || trimmed.startsWith("data:image/")) {
    return trimmed.length <= 500000;
  }
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && trimmed.length <= 2048;
  } catch {
    return false;
  }
}

function validateAndNormalizeEpisodeInput(
  raw: any,
  defaultOrder = 1
): { error?: string; normalized?: Omit<Episode, "id" | "animeId" | "createdAt"> } {
  const epNum = Number(raw?.number);
  if (!Number.isFinite(epNum) || !Number.isInteger(epNum) || epNum < 0 || epNum > 10000) {
    return { error: "Episode number must be a whole number between 0 and 10000." };
  }

  const epSeason = raw?.season !== undefined ? Number(raw.season) : 1;
  if (!Number.isFinite(epSeason) || !Number.isInteger(epSeason) || epSeason < 1 || epSeason > 200) {
    return { error: "Season number must be a whole number between 1 and 200." };
  }

  const cleanTitle = String(raw?.title || "").trim() || `Episode ${epNum}`;
  if (cleanTitle.length > 200) {
    return { error: "Episode title must be 200 characters or fewer." };
  }

  const rawLanguage = raw?.language !== undefined && String(raw.language).trim()
    ? String(raw.language).trim().slice(0, 40)
    : "Japanese";
  if (!rawLanguage) {
    return { error: "Episode audio language is required." };
  }

  if (!isValidOptionalThumbUrl(raw?.thumbnailUrl)) {
    return { error: `Episode ${epNum} has an invalid Thumbnail URL.` };
  }

  const cleanDesc = String(raw?.description ?? raw?.synopsis ?? "").trim().slice(0, 2000);
  const cleanThumb = String(raw?.thumbnailUrl || "").trim();
  const cleanDuration = String(raw?.duration || "24m").trim().slice(0, 32) || "24m";

  const dedupedSourcesMap = new Map<string, { label: string; url: string; quality: string; type: string }>();
  if (Array.isArray(raw?.sources)) {
    for (const s of raw.sources) {
      const candidateUrl = String(s?.url || "").trim();
      if (!s || !isValidStreamOrMediaUrl(candidateUrl)) continue;
      try {
        const parsed = new URL(candidateUrl, "https://ygflash.local");
        if (parsed.hostname.toLowerCase().endsWith("mediadelivery.net") && !parsed.pathname.toLowerCase().includes(".m3u8")) {
          return {
            error: `Episode ${epNum}: Paste the Bunny Stream HLS Playlist URL (.m3u8), not the mediadelivery iframe webpage URL.`,
          };
        }
      } catch {}
      const normQ = normalizeQualityServer(s.quality || s.label);
      const inferredType = inferStreamMimeTypeServer(candidateUrl);
      const providedType = String(s.type || "").trim();
      dedupedSourcesMap.set(normQ.toLowerCase(), {
        label: String(s.label || normQ).trim().slice(0, 60),
        url: candidateUrl,
        quality: normQ,
        type: providedType && providedType !== "video/mp4" ? providedType : inferredType,
      });
    }
  }

  const rawPrimaryUrl = String(raw?.videoUrl || "").trim();
  if (isValidStreamOrMediaUrl(rawPrimaryUrl)) {
    try {
      const parsedPrimary = new URL(rawPrimaryUrl, "https://ygflash.local");
      if (parsedPrimary.hostname.toLowerCase().endsWith("mediadelivery.net") && !parsedPrimary.pathname.toLowerCase().includes(".m3u8")) {
        return {
          error: `Episode ${epNum}: Paste the Bunny Stream HLS Playlist URL (.m3u8), not the mediadelivery iframe webpage URL.`,
        };
      }
    } catch {}
  }
  if (dedupedSourcesMap.size === 0 && !isValidStreamOrMediaUrl(rawPrimaryUrl)) {
    return {
      error: `Episode ${epNum} (${cleanTitle}) requires at least one valid Video URL (YouTube, HLS .m3u8, MP4, or uploaded file).`,
    };
  }

  const sortedSources = Array.from(dedupedSourcesMap.values()).sort(
    (a, b) => qualityRankServer(b.quality) - qualityRankServer(a.quality)
  );
  const rawPrimaryType = inferStreamMimeTypeServer(rawPrimaryUrl);
  const finalSources =
    sortedSources.length > 0
      ? sortedSources
      : [{
          label: rawPrimaryType === "application/x-mpegURL" ? "Bunny / HLS Adaptive (.m3u8)" : "1080p Full HD",
          url: rawPrimaryUrl,
          quality: "1080p",
          type: rawPrimaryType,
        }];

  const primaryVideoUrl = isValidStreamOrMediaUrl(rawPrimaryUrl)
    ? rawPrimaryUrl
    : finalSources.find((s) => s.quality === "1080p")?.url || finalSources[0].url;

  const rawOrder = raw?.order !== undefined ? Number(raw.order) : defaultOrder;
  const cleanOrder =
    Number.isFinite(rawOrder) && rawOrder >= 0 ? Math.min(100000, Math.round(rawOrder)) : epNum;
  const cleanReleaseDate = String(raw?.releaseDate || "").trim().slice(0, 40);
  const cleanBunnyVideoId = String(raw?.bunnyVideoId || "").trim().slice(0, 128);

  return {
    normalized: {
      number: epNum,
      season: epSeason,
      title: cleanTitle,
      language: rawLanguage as EpisodeLanguage,
      synopsis: cleanDesc,
      description: cleanDesc,
      duration: cleanDuration,
      ...(cleanReleaseDate ? { releaseDate: cleanReleaseDate } : {}),
      ...(cleanBunnyVideoId ? { bunnyVideoId: cleanBunnyVideoId } : {}),
      videoUrl: primaryVideoUrl,
      thumbnailUrl: cleanThumb,
      order: cleanOrder,
      sources: finalSources,
    },
  };
}

// Create New Episode (Admin only — ALWAYS creates a new unique episode record, never overwrites existing)
app.post("/api/admin/episodes", verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { id, animeId } = req.body;
    const cleanAnimeId = String(animeId || "").trim();
    if (!cleanAnimeId) {
      return res.status(400).json({ error: "Anime ID is required." });
    }

    const db = readDatabase();
    const existingEps = db.episodes.filter((e) => e.animeId === cleanAnimeId);
    const maxOrder = existingEps.reduce((m, e) => Math.max(m, e.order ?? e.number ?? 0), 0);

    const { error, normalized } = validateAndNormalizeEpisodeInput(req.body, maxOrder + 1);
    if (error || !normalized) {
      return res.status(400).json({ error: error || "Invalid episode payload." });
    }

    const requestedId = typeof id === "string" && id.trim() ? id.trim() : "";
    if (requestedId && db.episodes.some((e) => e.id === requestedId)) {
      return res.status(409).json({
        error: "An episode with this ID already exists. Use PUT /api/admin/episodes/:id to update.",
      });
    }

    const resolvedId =
      requestedId || `ep-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const nowIso = new Date().toISOString();

    const parentAnimeRaw = req.body?.parentAnime;
    if (parentAnimeRaw && typeof parentAnimeRaw === "object" && !db.anime.some((a) => a.id === cleanAnimeId)) {
      const pTitle = String(parentAnimeRaw.title || "").trim();
      if (pTitle) {
        const pCast = sanitizeCastServer(parentAnimeRaw.cast);
        db.anime.unshift({
          id: cleanAnimeId,
          title: pTitle.slice(0, 200),
          titleJapanese: String(parentAnimeRaw.titleJapanese || "").slice(0, 200),
          synopsis: String(parentAnimeRaw.synopsis || `Stream ${pTitle}`).slice(0, 5000),
          posterImage: String(parentAnimeRaw.posterImage || ""),
          bannerImage: String(parentAnimeRaw.bannerImage || parentAnimeRaw.posterImage || ""),
          genres: Array.isArray(parentAnimeRaw.genres) ? parentAnimeRaw.genres.map(String) : [],
          rating: String(parentAnimeRaw.rating || "13+").slice(0, 32) || "13+",
          status: parentAnimeRaw.status === "Completed" ? "Completed" : "Ongoing",
          year: parseNonNegativeInt(parentAnimeRaw.year, new Date().getFullYear(), 1950, 2100),
          seasons: parseNonNegativeInt(parentAnimeRaw.seasons, 1, 1, 200),
          episodesCount: parseNonNegativeInt(parentAnimeRaw.episodesCount, 0, 0, 10000),
          isPublished: parentAnimeRaw.isPublished !== false,
          featured: Boolean(parentAnimeRaw.featured),
          trending: Boolean(parentAnimeRaw.trending),
          ...(parentAnimeRaw.studio ? { studio: String(parentAnimeRaw.studio).trim().slice(0, 200) } : {}),
          ...(parentAnimeRaw.author ? { author: String(parentAnimeRaw.author).trim().slice(0, 200) } : {}),
          ...(parentAnimeRaw.director ? { director: String(parentAnimeRaw.director).trim().slice(0, 200) } : {}),
          ...(parentAnimeRaw.productionCompany
            ? { productionCompany: String(parentAnimeRaw.productionCompany).trim().slice(0, 200) }
            : {}),
          ...(pCast.length > 0 ? { cast: pCast } : {}),
          streamingSources: Array.isArray(parentAnimeRaw.streamingSources) ? parentAnimeRaw.streamingSources : [],
          createdAt: String(parentAnimeRaw.createdAt || new Date().toISOString()),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const parentAnimeEntry = db.anime.find((a) => a.id === cleanAnimeId);
    const resolvedPublished =
      typeof req.body?.isPublished === "boolean"
        ? req.body.isPublished
        : parentAnimeEntry
        ? Boolean(parentAnimeEntry.isPublished)
        : true;

    const newEpisode: Episode = {
      id: resolvedId,
      animeId: cleanAnimeId,
      ...normalized,
      isPublished: resolvedPublished,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    db.episodes.push(newEpisode);
    writeDatabase(db);
    catalogEmitter.emit("update");

    return res.status(201).json({ success: true, episode: newEpisode });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to add episode." });
  }
});

// Bulk Add Episodes (Admin only — validates every episode atomically before saving up to 100 episodes)
app.post("/api/admin/episodes/bulk", verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const cleanAnimeId = String(req.body?.animeId || "").trim();
    const rawEpisodes = req.body?.episodes;

    if (!cleanAnimeId) {
      return res.status(400).json({ error: "Anime ID is required for bulk upload." });
    }
    if (!Array.isArray(rawEpisodes) || rawEpisodes.length === 0) {
      return res.status(400).json({ error: "Provide at least 1 episode in bulk payload." });
    }
    if (rawEpisodes.length > 100) {
      return res.status(400).json({ error: "Bulk upload supports up to 100 episodes per batch." });
    }

    const db = readDatabase();
    const parentAnimeRaw = req.body?.parentAnime;
    if (parentAnimeRaw && typeof parentAnimeRaw === "object" && !db.anime.some((a) => a.id === cleanAnimeId)) {
      const pTitle = String(parentAnimeRaw.title || "").trim();
      if (pTitle) {
        const pCast = sanitizeCastServer(parentAnimeRaw.cast);
        db.anime.unshift({
          id: cleanAnimeId,
          title: pTitle.slice(0, 200),
          titleJapanese: String(parentAnimeRaw.titleJapanese || "").slice(0, 200),
          synopsis: String(parentAnimeRaw.synopsis || `Stream ${pTitle}`).slice(0, 5000),
          posterImage: String(parentAnimeRaw.posterImage || ""),
          bannerImage: String(parentAnimeRaw.bannerImage || parentAnimeRaw.posterImage || ""),
          genres: Array.isArray(parentAnimeRaw.genres) ? parentAnimeRaw.genres.map(String) : [],
          rating: String(parentAnimeRaw.rating || "13+").slice(0, 32) || "13+",
          status: parentAnimeRaw.status === "Completed" ? "Completed" : "Ongoing",
          year: parseNonNegativeInt(parentAnimeRaw.year, new Date().getFullYear(), 1950, 2100),
          seasons: parseNonNegativeInt(parentAnimeRaw.seasons, 1, 1, 200),
          episodesCount: parseNonNegativeInt(parentAnimeRaw.episodesCount, 0, 0, 10000),
          isPublished: parentAnimeRaw.isPublished !== false,
          featured: Boolean(parentAnimeRaw.featured),
          trending: Boolean(parentAnimeRaw.trending),
          ...(parentAnimeRaw.studio ? { studio: String(parentAnimeRaw.studio).trim().slice(0, 200) } : {}),
          ...(parentAnimeRaw.author ? { author: String(parentAnimeRaw.author).trim().slice(0, 200) } : {}),
          ...(parentAnimeRaw.director ? { director: String(parentAnimeRaw.director).trim().slice(0, 200) } : {}),
          ...(parentAnimeRaw.productionCompany
            ? { productionCompany: String(parentAnimeRaw.productionCompany).trim().slice(0, 200) }
            : {}),
          ...(pCast.length > 0 ? { cast: pCast } : {}),
          streamingSources: Array.isArray(parentAnimeRaw.streamingSources) ? parentAnimeRaw.streamingSources : [],
          createdAt: String(parentAnimeRaw.createdAt || new Date().toISOString()),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const parentAnimeEntry = db.anime.find((a) => a.id === cleanAnimeId);
    const bulkPublished =
      typeof req.body?.isPublished === "boolean"
        ? req.body.isPublished
        : parentAnimeEntry
        ? Boolean(parentAnimeEntry.isPublished)
        : true;

    const existingEps = db.episodes.filter((e) => e.animeId === cleanAnimeId);
    let nextOrder = existingEps.reduce((m, e) => Math.max(m, e.order ?? e.number ?? 0), 0);

    const validatedToCreate: Episode[] = [];
    const seenIds = new Set(db.episodes.map((e) => e.id));
    const nowIso = new Date().toISOString();

    for (let i = 0; i < rawEpisodes.length; i++) {
      nextOrder += 1;
      const item = rawEpisodes[i];
      const { error, normalized } = validateAndNormalizeEpisodeInput(item, nextOrder);
      if (error || !normalized) {
        return res.status(400).json({
          error: `Row ${i + 1}: ${error || "Invalid episode data."}`,
          invalidIndex: i,
        });
      }

      let candidateId =
        typeof item?.id === "string" && item.id.trim() && !seenIds.has(item.id.trim())
          ? item.id.trim()
          : `ep-${Date.now()}-${i + 1}-${crypto.randomBytes(3).toString("hex")}`;
      while (seenIds.has(candidateId)) {
        candidateId = `ep-${Date.now()}-${i + 1}-${crypto.randomBytes(4).toString("hex")}`;
      }
      seenIds.add(candidateId);

      validatedToCreate.push({
        id: candidateId,
        animeId: cleanAnimeId,
        ...normalized,
        isPublished: typeof item?.isPublished === "boolean" ? item.isPublished : bulkPublished,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }

    db.episodes.push(...validatedToCreate);
    writeDatabase(db);
    catalogEmitter.emit("update");

    return res.status(201).json({
      success: true,
      count: validatedToCreate.length,
      episodes: validatedToCreate,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to bulk save episodes." });
  }
});

// Reorder Episodes (Admin only — persists custom episode order)
app.post("/api/admin/episodes/reorder", verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const cleanAnimeId = String(req.body?.animeId || "").trim();
    const orderedIds = req.body?.orderedEpisodeIds;
    if (!cleanAnimeId || !Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: "animeId and orderedEpisodeIds array are required." });
    }

    const db = readDatabase();
    const rankMap = new Map<string, number>();
    orderedIds.forEach((epId: unknown, idx: number) => {
      if (typeof epId === "string" && epId.trim()) {
        rankMap.set(epId.trim(), idx + 1);
      }
    });

    const nowIso = new Date().toISOString();
    let updatedCount = 0;
    db.episodes = db.episodes.map((ep) => {
      if (ep.animeId === cleanAnimeId && rankMap.has(ep.id)) {
        updatedCount += 1;
        return {
          ...ep,
          order: rankMap.get(ep.id)!,
          updatedAt: nowIso,
        };
      }
      return ep;
    });

    writeDatabase(db);
    catalogEmitter.emit("update");
    return res.json({ success: true, updatedCount });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to reorder episodes." });
  }
});

// Edit Specific Episode by ID (Admin only — seamlessly upserts Firebase-synced episodes too)
app.put("/api/admin/episodes/:id", verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = readDatabase();
    const index = db.episodes.findIndex((e) => e.id === id);

    const parentAnimeRaw = req.body?.parentAnime;
    const reqAnimeId = String(req.body?.animeId || "").trim();
    if (
      parentAnimeRaw &&
      typeof parentAnimeRaw === "object" &&
      reqAnimeId &&
      !db.anime.some((a) => a.id === reqAnimeId)
    ) {
      const pTitle = String(parentAnimeRaw.title || "").trim();
      if (pTitle) {
        db.anime.unshift({
          id: reqAnimeId,
          title: pTitle.slice(0, 200),
          titleJapanese: String(parentAnimeRaw.titleJapanese || "").slice(0, 200),
          synopsis: String(parentAnimeRaw.synopsis || `Stream ${pTitle}`).slice(0, 5000),
          posterImage: String(parentAnimeRaw.posterImage || ""),
          bannerImage: String(parentAnimeRaw.bannerImage || parentAnimeRaw.posterImage || ""),
          genres: Array.isArray(parentAnimeRaw.genres) ? parentAnimeRaw.genres.map(String) : [],
          rating: String(parentAnimeRaw.rating || "13+").slice(0, 32) || "13+",
          status: parentAnimeRaw.status === "Completed" ? "Completed" : "Ongoing",
          year: parseNonNegativeInt(parentAnimeRaw.year, new Date().getFullYear(), 1950, 2100),
          seasons: parseNonNegativeInt(parentAnimeRaw.seasons, 1, 1, 200),
          episodesCount: parseNonNegativeInt(parentAnimeRaw.episodesCount, 0, 0, 10000),
          isPublished: parentAnimeRaw.isPublished !== false,
          streamingSources: Array.isArray(parentAnimeRaw.streamingSources) ? parentAnimeRaw.streamingSources : [],
          createdAt: String(parentAnimeRaw.createdAt || new Date().toISOString()),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    if (index === -1) {
      if (!reqAnimeId) {
        return res.status(404).json({ error: "Episode not found." });
      }
      const { error, normalized } = validateAndNormalizeEpisodeInput(
        req.body,
        parseNonNegativeInt(req.body?.order, parseNonNegativeInt(req.body?.number, 1, 0, 10000), 0, 100000)
      );
      if (error || !normalized) {
        return res.status(400).json({ error: error || "Invalid episode payload." });
      }
      const nowIso = new Date().toISOString();
      const parentEntry = db.anime.find((a) => a.id === reqAnimeId);
      const upsertedEpisode: Episode = {
        id,
        animeId: reqAnimeId,
        ...normalized,
        isPublished:
          typeof req.body?.isPublished === "boolean"
            ? req.body.isPublished
            : parentEntry
            ? Boolean(parentEntry.isPublished)
            : true,
        createdAt:
          typeof req.body?.createdAt === "string" && req.body.createdAt.trim()
            ? req.body.createdAt.trim()
            : nowIso,
        updatedAt: nowIso,
      };
      db.episodes.push(upsertedEpisode);
      writeDatabase(db);
      catalogEmitter.emit("update");
      return res.json({ success: true, episode: upsertedEpisode, upserted: true });
    }

    const current = db.episodes[index];
    const mergedPayload = {
      ...current,
      ...req.body,
      id: current.id,
      animeId: current.animeId,
    };

    const { error, normalized } = validateAndNormalizeEpisodeInput(
      mergedPayload,
      current.order ?? current.number
    );
    if (error || !normalized) {
      return res.status(400).json({ error: error || "Invalid episode update payload." });
    }

    const updatedEpisode: Episode = {
      id: current.id,
      animeId: current.animeId,
      ...normalized,
      isPublished:
        typeof req.body?.isPublished === "boolean"
          ? req.body.isPublished
          : current.isPublished !== false,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };

    db.episodes[index] = updatedEpisode;
    writeDatabase(db);
    catalogEmitter.emit("update");

    return res.json({ success: true, episode: updatedEpisode });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to update episode." });
  }
});

// Delete Episode (Admin only)
app.delete("/api/admin/episodes/:id", verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = readDatabase();
    db.episodes = db.episodes.filter((e) => e.id !== id);
    writeDatabase(db);
    catalogEmitter.emit("update");
    return res.json({ success: true, message: "Episode deleted." });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to delete episode." });
  }
});

// File Upload (Posters, Banners, Episode Videos) (Admin only)
app.post("/api/upload", verifyAdminAuth, upload.single("file"), (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  return res.json({
    success: true,
    url: fileUrl,
    filename: req.file.filename,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });
});

// Chunked Large Video Upload (Supports parallel positional writes + multipart/form-data + raw binary fallback)
app.post(
  "/api/upload-chunk",
  (req: Request, res: Response, next: NextFunction) => {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("multipart/form-data")) {
      return chunkUpload.single("chunk")(req, res, next);
    }
    return express.raw({ type: "application/octet-stream", limit: "12mb" })(req, res, next);
  },
  verifyAdminAuth,
  async (req: Request, res: Response) => {
    try {
      const uploadId = String(
        req.body?.uploadId || req.headers["x-upload-id"] || ""
      ).replace(/[^a-zA-Z0-9_-]/g, "");
      const chunkIndex = Number(
        req.body?.chunkIndex !== undefined ? req.body.chunkIndex : req.headers["x-chunk-index"]
      );
      const totalChunks = Number(
        req.body?.totalChunks !== undefined ? req.body.totalChunks : req.headers["x-total-chunks"]
      );
      const rawOffset =
        req.body?.chunkOffset !== undefined ? req.body.chunkOffset : req.headers["x-chunk-offset"];
      const chunkOffset = rawOffset !== undefined ? Number(rawOffset) : NaN;
      const deferFinalize = String(req.body?.deferFinalize || req.headers["x-defer-finalize"] || "") === "1";
      const rawFilename = String(
        req.body?.filename ||
          (req.headers["x-filename"] ? decodeURIComponent(String(req.headers["x-filename"])) : "video.mp4")
      );
      const rawExt = (path.extname(rawFilename) || ".mp4").toLowerCase();
      const safeExt = SAFE_VIDEO_CHUNK_EXTS.has(rawExt) ? rawExt : ".mp4";

      if (!uploadId || Number.isNaN(chunkIndex) || Number.isNaN(totalChunks) || totalChunks < 1) {
        return res.status(400).json({ error: "Invalid chunk metadata." });
      }

      const chunkBuffer: Buffer | undefined = req.file?.buffer
        ? req.file.buffer
        : Buffer.isBuffer(req.body)
        ? req.body
        : undefined;

      if (!chunkBuffer || chunkBuffer.length === 0) {
        return res.status(400).json({ error: "Empty video chunk received." });
      }

      const tempFilename = `.part_${uploadId}${safeExt}`;
      const tempPath = path.join(UPLOADS_DIR, tempFilename);

      // Atomically ensure temp file exists without truncating parallel/retried chunks
      const initFd = fs.openSync(tempPath, "a");
      fs.closeSync(initFd);

      if (!Number.isNaN(chunkOffset) && chunkOffset >= 0) {
        const handle = await fs.promises.open(tempPath, "r+");
        try {
          await handle.write(chunkBuffer, 0, chunkBuffer.length, chunkOffset);
        } finally {
          await handle.close();
        }
      } else {
        await fs.promises.appendFile(tempPath, chunkBuffer);
      }

      if (!deferFinalize && chunkIndex + 1 >= totalChunks) {
        const finalFilename = `video-${uploadId}${safeExt}`;
        const finalPath = path.join(UPLOADS_DIR, finalFilename);
        await fs.promises.rename(tempPath, finalPath);
        const remuxed = await ensureWebStreamableVideo(finalPath, finalFilename);
        return res.json({
          success: true,
          completed: true,
          url: `/uploads/${remuxed.filename}`,
          filename: remuxed.filename,
          size: remuxed.size,
        });
      }

      return res.json({
        success: true,
        completed: false,
        chunkIndex,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Failed to process video chunk." });
    }
  }
);

// Fast-remux MKV/MOV/non-faststart videos to universal browser-playable MP4 (+faststart) when possible
async function ensureWebStreamableVideo(
  filePath: string,
  filename: string
): Promise<{ filename: string; filePath: string; size: number }> {
  const ext = path.extname(filename).toLowerCase();
  const videoExts = [".mkv", ".mov", ".avi", ".m4v", ".ts", ".flv", ".3gp", ".mp4"];
  const fallbackStat = await fs.promises.stat(filePath);
  if (!videoExts.includes(ext)) {
    return { filename, filePath, size: fallbackStat.size };
  }

  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", filePath],
      { timeout: 4000 }
    );
    const probe = JSON.parse(stdout || "{}");
    const streams: any[] = Array.isArray(probe.streams) ? probe.streams : [];
    const vStream = streams.find((s) => s.codec_type === "video");
    const aStream = streams.find((s) => s.codec_type === "audio");
    const vCodec = String(vStream?.codec_name || "").toLowerCase();
    const aCodec = String(aStream?.codec_name || "").toLowerCase();

    if (vCodec === "h264" || vCodec === "hevc") {
      const mp4Filename = ext === ".mp4" ? filename : filename.replace(/\.[^.]+$/, ".mp4");
      const tempOutPath = path.join(UPLOADS_DIR, `.fast_${Date.now()}_${mp4Filename}`);
      const aCopy = !aStream || ["aac", "mp3", "mp4a"].includes(aCodec);
      const args = [
        "-y",
        "-i",
        filePath,
        "-map",
        "0:v:0",
        ...(aStream ? ["-map", "0:a:0?"] : []),
        "-c:v",
        "copy",
        ...(vCodec === "hevc" ? ["-tag:v", "hvc1"] : []),
        ...(aStream ? (aCopy ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]) : []),
        "-movflags",
        "+faststart",
        tempOutPath,
      ];

      await execFileAsync("ffmpeg", args, { timeout: 12000 });
      const outStat = await fs.promises.stat(tempOutPath);
      if (outStat.size > 0) {
        const targetPath = path.join(UPLOADS_DIR, mp4Filename);
        await fs.promises.rename(tempOutPath, targetPath);
        if (targetPath !== filePath && fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath).catch(() => {});
        }
        return { filename: mp4Filename, filePath: targetPath, size: outStat.size };
      }
      await fs.promises.unlink(tempOutPath).catch(() => {});
    }
  } catch {
    // Clean up any leftover temp file and fall back cleanly to the original uploaded video
    try {
      for (const f of fs.readdirSync(UPLOADS_DIR)) {
        if (f.startsWith(".fast_") && f.includes(path.parse(filename).name)) {
          fs.unlinkSync(path.join(UPLOADS_DIR, f));
        }
      }
    } catch {}
  }

  return { filename, filePath, size: fallbackStat.size };
}

// Explicit finalization after all parallel/split chunks have finished writing at their byte offsets
app.post("/api/upload-chunk/complete", verifyAdminAuth, async (req: Request, res: Response) => {
  try {
    const uploadId = String(req.body?.uploadId || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const rawFilename = String(req.body?.filename || "video.mp4");
    const expectedSize = Number(req.body?.expectedSize || 0);
    const rawExt = (path.extname(rawFilename) || ".mp4").toLowerCase();
    const safeExt = SAFE_VIDEO_CHUNK_EXTS.has(rawExt) ? rawExt : ".mp4";

    if (!uploadId) {
      return res.status(400).json({ error: "Missing uploadId for finalization." });
    }

    const tempPath = path.join(UPLOADS_DIR, `.part_${uploadId}${safeExt}`);
    const finalFilename = `video-${uploadId}${safeExt}`;
    const finalPath = path.join(UPLOADS_DIR, finalFilename);
    const remuxedFilename = `video-${uploadId}.mp4`;
    const remuxedPath = path.join(UPLOADS_DIR, remuxedFilename);

    // Handle idempotent retry if final file was already renamed/remuxed on an earlier attempt
    if (!fs.existsSync(tempPath) && (fs.existsSync(remuxedPath) || fs.existsSync(finalPath))) {
      const existingName = fs.existsSync(remuxedPath) ? remuxedFilename : finalFilename;
      const existingPath = fs.existsSync(remuxedPath) ? remuxedPath : finalPath;
      const stat = await fs.promises.stat(existingPath);
      return res.json({
        success: true,
        completed: true,
        url: `/uploads/${existingName}`,
        filename: existingName,
        size: stat.size,
      });
    }

    if (!fs.existsSync(tempPath)) {
      return res.status(404).json({ error: "Upload temporary file missing. Please re-select the video." });
    }

    const tempStat = await fs.promises.stat(tempPath);
    if (expectedSize > 0 && tempStat.size < expectedSize) {
      return res.status(409).json({
        error: `Upload incomplete (${tempStat.size} of ${expectedSize} bytes received).`,
      });
    }

    await fs.promises.rename(tempPath, finalPath);
    const streamed = await ensureWebStreamableVideo(finalPath, finalFilename);

    return res.json({
      success: true,
      completed: true,
      url: `/uploads/${streamed.filename}`,
      filename: streamed.filename,
      size: streamed.size,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to finalize uploaded video." });
  }
});

app.delete("/api/upload-chunk/:uploadId", verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const uploadId = String(req.params.uploadId || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (uploadId) {
      const files = fs.readdirSync(UPLOADS_DIR);
      for (const f of files) {
        if (f.startsWith(`.part_${uploadId}`)) {
          fs.unlinkSync(path.join(UPLOADS_DIR, f));
        }
      }
    }
    return res.json({ success: true });
  } catch {
    return res.json({ success: false });
  }
});


// Read-only Vidmoly embed pre-flight inspection (strictly checks HTTP availability and framing headers; never proxies media or bypasses host controls)
app.get("/api/stream/embed-check", async (req: Request, res: Response) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!rawUrl || rawUrl.length > 512) {
    return res.status(400).json({ error: "Missing or invalid embed URL." });
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: "Invalid Vidmoly embed URL format." });
  }

  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !/(?:^|\.)vidmoly\.[a-z]{2,6}$/i.test(host)) {
    return res.status(400).json({ error: "Only HTTPS Vidmoly embed URLs can be checked here." });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const resp = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; YGFlashPlayerCheck/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);

    const finalUrl = resp.url || parsed.toString();
    let finalHost = "";
    let finalProtocol = "";
    try {
      const fParsed = new URL(finalUrl);
      finalHost = fParsed.hostname.toLowerCase();
      finalProtocol = fParsed.protocol;
    } catch {}

    if (finalProtocol !== "https:" || !/(?:^|\.)vidmoly\.[a-z]{2,6}$/i.test(finalHost)) {
      return res.json({
        embeddable: false,
        status: resp.status,
        finalUrl,
        code: "HTTP_REDIRECT_BLOCKED",
        reason: "Vidmoly URL redirected away from HTTPS or off the official Vidmoly domain.",
      });
    }

    const rawXfo = (resp.headers.get("x-frame-options") || "").trim();
    if (rawXfo) {
      const xfoTokens = rawXfo
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);

      if (xfoTokens.includes("DENY")) {
        return res.json({
          embeddable: false,
          status: resp.status,
          finalUrl,
          code: "XFO_DENY",
          reason: `Vidmoly host denied iframe embedding (X-Frame-Options: ${rawXfo}).`,
        });
      }

      if (xfoTokens.includes("SAMEORIGIN")) {
        return res.json({
          embeddable: false,
          status: resp.status,
          finalUrl,
          code: "XFO_SAMEORIGIN",
          reason: `Vidmoly host only allows same-origin framing (X-Frame-Options: ${rawXfo}).`,
        });
      }

      // Chromium/Android WebView treat duplicate/conflicting comma-separated X-Frame-Options
      // headers (e.g. "ALLOWALL, ALLOWALL") as XFrameOptionsDisposition::kConflict -> ERR_BLOCKED_BY_RESPONSE
      if (xfoTokens.length > 1 || xfoTokens.some((tok) => tok !== "ALLOWALL")) {
        return res.json({
          embeddable: false,
          status: resp.status,
          finalUrl,
          code: "ERR_BLOCKED_BY_RESPONSE",
          reason: `Vidmoly sent conflicting X-Frame-Options headers ("${rawXfo}"), causing browsers to block the iframe (ERR_BLOCKED_BY_RESPONSE). Open the source link externally or attach a YouTube, HLS (.m3u8), or MP4 stream in Admin Studio.`,
        });
      }
    }

    const csp = resp.headers.get("content-security-policy") || "";
    const faMatch = csp.match(/frame-ancestors\s+([^;]+)/i);
    if (faMatch?.[1]) {
      const directives = faMatch[1].trim().toLowerCase();
      if (
        directives.includes("'none'") ||
        directives.includes("'self'") ||
        !directives.includes("*")
      ) {
        return res.json({
          embeddable: false,
          status: resp.status,
          finalUrl,
          code: "CSP_FRAME_ANCESTORS",
          reason: "Vidmoly CSP frame-ancestors policy restricts embedding inside external apps.",
        });
      }
    }

    if (resp.status === 404 || resp.status === 410 || resp.status === 451) {
      return res.json({
        embeddable: false,
        status: resp.status,
        finalUrl,
        code: `HTTP_${resp.status}`,
        reason: `Vidmoly video unavailable or removed (HTTP ${resp.status}).`,
      });
    }

    if (resp.status >= 400) {
      return res.json({
        embeddable: false,
        status: resp.status,
        finalUrl,
        code: `HTTP_${resp.status}`,
        reason: `Vidmoly returned HTTP ${resp.status} for this embed URL.`,
      });
    }

    // Read small HTML snippet to catch soft-404 pages ("Video not found" / "File was deleted")
    const bodyText = (await resp.text()).slice(0, 8192);
    if (/\b(?:video not found|file was deleted|no such file|this video has been removed)\b/i.test(bodyText)) {
      return res.json({
        embeddable: false,
        status: resp.status,
        finalUrl,
        code: "HOST_MEDIA_DELETED",
        reason: "This Vidmoly video is unavailable or has been removed by the host.",
      });
    }

    return res.json({
      embeddable: true,
      status: resp.status,
      finalUrl,
      code: "OK",
    });
  } catch (err: any) {
    clearTimeout(timer);
    const isTimeout = err?.name === "AbortError";
    return res.json({
      embeddable: false,
      status: 0,
      finalUrl: parsed.toString(),
      code: isTimeout ? "NETWORK_TIMEOUT" : "NETWORK_ERROR",
      reason: isTimeout
        ? "Timed out connecting to Vidmoly embed server."
        : "Unable to reach Vidmoly embed server from this environment.",
    });
  }
});


// ==================== ADMIN PLATFORM STATS & USERS OVERVIEW ====================
app.get("/api/admin/stats", verifyAdminAuth, (_req: Request, res: Response) => {
  try {
    const db = readDatabase();
    const totalAnime = db.anime.length;
    const publishedAnime = db.anime.filter((a) => a.isPublished).length;
    const draftAnime = totalAnime - publishedAnime;
    const trendingCount = db.anime.filter((a) => Boolean(a.trending)).length;
    const totalEpisodes = db.episodes.length;
    const publishedEpisodes = db.episodes.filter((e) => e.isPublished !== false).length;
    const usersMap = db.userProfiles || {};
    const totalUsers = Object.keys(usersMap).length;
    const enrichedAnimeCount = db.anime.filter(
      (a) => Boolean(a.studio || a.author || a.director || (Array.isArray(a.cast) && a.cast.length > 0))
    ).length;

    return res.json({
      success: true,
      stats: {
        totalAnime,
        publishedAnime,
        draftAnime,
        trendingCount,
        enrichedAnimeCount,
        totalEpisodes,
        publishedEpisodes,
        draftEpisodes: totalEpisodes - publishedEpisodes,
        totalUsers,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load admin statistics." });
  }
});

app.get("/api/admin/users", verifyAdminAuth, (_req: Request, res: Response) => {
  try {
    const db = readDatabase();
    const profiles = Object.values(db.userProfiles || {}).map((p) => ({
      uid: p.uid,
      displayName: p.displayName || "Otaku Explorer",
      themeMode: p.themeMode || "dark",
      colorTheme: p.colorTheme || "emerald",
      favoritesCount: Array.isArray(p.favorites) ? p.favorites.length : 0,
      watchlistCount: Array.isArray(p.watchlist) ? p.watchlist.length : 0,
      historyCount: Array.isArray(p.watchHistory) ? p.watchHistory.length : 0,
      createdAt: p.createdAt || null,
      updatedAt: p.updatedAt || null,
    }));
    profiles.sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });
    return res.json({
      success: true,
      totalUsers: profiles.length,
      users: profiles,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load users overview." });
  }
});

// ==================== SAFE HLS MASTER PLAYLIST INSPECTOR (SSRF-HARDENED) ====================
function isDisallowedIpAddress(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/i, "");
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(normalized)) {
    const lower = normalized.toLowerCase();
    if (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fe80:") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("ff")
    ) {
      return true;
    }
    return false;
  }
  return true;
}

export function parseHlsMasterManifestServer(manifestText: string) {
  const lines = manifestText.split(/\r?\n/).map((l) => l.trim());
  const renditions: {
    resolution: string;
    width: number;
    height: number;
    bandwidth: number;
    bitrateKbps: number;
    codecs?: string;
    audio?: string;
    uri: string;
  }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = line.slice("#EXT-X-STREAM-INF:".length);
    const bwMatch = attrs.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
    const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/i);
    const codecsMatch = attrs.match(/CODECS="([^"]+)"/i);
    const audioMatch = attrs.match(/AUDIO="([^"]+)"/i);

    let nextUri = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith("#")) {
        nextUri = lines[j];
        break;
      }
    }

    const width = resMatch ? parseInt(resMatch[1], 10) : 0;
    const height = resMatch ? parseInt(resMatch[2], 10) : 0;
    const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
    renditions.push({
      resolution: height > 0 ? `${height}p` : "Unknown",
      width,
      height,
      bandwidth,
      bitrateKbps: Math.round(bandwidth / 1000),
      ...(codecsMatch?.[1] ? { codecs: codecsMatch[1] } : {}),
      ...(audioMatch?.[1] ? { audio: audioMatch[1] } : {}),
      uri: nextUri,
    });
  }

  renditions.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return renditions;
}

app.get("/api/stream/hls-inspect", async (req: Request, res: Response) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!rawUrl || rawUrl.length > 1024) {
    return res.status(400).json({ error: "Missing or invalid HLS playlist URL." });
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL format." });
  }

  if (parsed.protocol !== "https:") {
    return res.status(400).json({ error: "Only HTTPS HLS playlist URLs can be inspected." });
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    net.isIP(host) !== 0
  ) {
    return res.status(400).json({ error: "Host is not permitted for remote playlist inspection." });
  }

  try {
    const resolved = await dns.promises.lookup(host, { all: true });
    if (!resolved || resolved.length === 0 || resolved.some((r) => isDisallowedIpAddress(r.address))) {
      return res.status(400).json({ error: "Blocked private or non-routable playlist host." });
    }
  } catch {
    return res.status(400).json({ error: "Unable to resolve playlist hostname." });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const resp = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "error",
      signal: ctrl.signal,
      headers: {
        Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain",
      },
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return res.status(502).json({
        error: `Playlist server returned HTTP ${resp.status}.`,
        status: resp.status,
      });
    }

    const body = (await resp.text()).slice(0, 262144);
    if (!body.includes("#EXTM3U")) {
      return res.status(422).json({ error: "Target URL did not return a valid #EXTM3U playlist." });
    }

    const renditions = parseHlsMasterManifestServer(body);
    return res.json({
      success: true,
      url: parsed.toString(),
      isMasterPlaylist: renditions.length > 0,
      renditionCount: renditions.length,
      renditions,
    });
  } catch (err: any) {
    clearTimeout(timer);
    return res.status(502).json({
      error: err?.name === "AbortError" ? "Timed out fetching HLS manifest." : "Failed to inspect HLS manifest.",
    });
  }
});

// ==================== ANILIST METADATA SEARCH & ENRICHMENT ====================
function formatAniListMediaResult(m: any) {
  const studioNodes: string[] = Array.isArray(m?.studios?.nodes)
    ? m.studios.nodes.map((n: any) => String(n?.name || "").trim()).filter(Boolean)
    : [];
  const mainStudios: string[] = Array.isArray(m?.studios?.edges)
    ? m.studios.edges
        .filter((e: any) => e?.isMain && e?.node?.name)
        .map((e: any) => String(e.node.name).trim())
    : [];
  const primaryStudio = mainStudios[0] || studioNodes[0] || "";
  const productionCompany =
    studioNodes.length > 0 ? Array.from(new Set(studioNodes)).slice(0, 3).join(", ") : primaryStudio;

  const staffEdges: any[] = Array.isArray(m?.staff?.edges) ? m.staff.edges : [];
  let author = "";
  let director = "";
  for (const edge of staffEdges) {
    const role = String(edge?.role || "").toLowerCase();
    const name = String(edge?.node?.name?.full || "").trim();
    if (!name) continue;
    if (!author && /(original creator|original story|story\s*&\s*art|\bauthor\b)/.test(role)) {
      author = name;
    }
    if (!director && /(\bdirector\b|chief director|series director)/.test(role)) {
      director = name;
    }
  }

  const charEdges: any[] = Array.isArray(m?.characters?.edges) ? m.characters.edges : [];
  const cast: AnimeCastMember[] = [];
  for (const edge of charEdges) {
    const characterName = String(edge?.node?.name?.full || "").trim();
    if (!characterName) continue;
    const vas: any[] = Array.isArray(edge?.voiceActors) ? edge.voiceActors : [];
    const jpVa =
      vas.find((v) => String(v?.languageV2 || "").toLowerCase() === "japanese") || vas[0];
    const voiceActor = String(jpVa?.name?.full || "").trim();
    if (!voiceActor) continue;
    cast.push({
      characterName: characterName.slice(0, 160),
      characterImage: String(edge?.node?.image?.large || edge?.node?.image?.medium || "").slice(0, 2048),
      voiceActor: voiceActor.slice(0, 160),
      language: String(jpVa?.languageV2 || "Japanese").slice(0, 64),
      role: String(edge?.role || "Supporting").slice(0, 64),
    });
    if (cast.length >= 12) break;
  }

  return {
    aniListId: m.id,
    title: m.title?.english || m.title?.romaji || "",
    titleJapanese: m.title?.native || m.title?.romaji || "",
    synopsis: (m.description || "").replace(/<[^>]*>?/gm, "").trim(),
    posterImage: m.coverImage?.extraLarge || m.coverImage?.large || "",
    bannerImage: m.bannerImage || m.coverImage?.extraLarge || "",
    genres: m.genres || [],
    year: m.seasonYear || new Date().getFullYear(),
    episodesCount: typeof m.episodes === "number" && m.episodes >= 0 ? m.episodes : 0,
    rating: m.isAdult ? "18+" : "13+",
    status: m.status === "FINISHED" ? "Completed" : "Ongoing",
    studio: primaryStudio,
    author,
    director,
    productionCompany,
    cast,
  };
}

// Only used for metadata lookup, does NOT import into catalog automatically.
app.get("/api/anilist/search", async (req: Request, res: Response) => {
  const { q } = req.query;
  if (!q || typeof q !== "string" || !q.trim()) {
    return res.status(400).json({ error: "Query parameter 'q' is required." });
  }

  const query = `
    query ($search: String) {
      Page(page: 1, perPage: 8) {
        media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
          id
          title {
            romaji
            english
            native
          }
          description(asHtml: false)
          coverImage {
            extraLarge
            large
          }
          bannerImage
          genres
          seasonYear
          episodes
          status
          isAdult
          studios {
            edges {
              isMain
              node { name }
            }
            nodes { name }
          }
          staff(sort: RELEVANCE, perPage: 12) {
            edges {
              role
              node {
                name { full }
              }
            }
          }
          characters(sort: [ROLE, RELEVANCE], perPage: 12) {
            edges {
              role
              node {
                name { full }
                image { large medium }
              }
              voiceActors(sort: RELEVANCE) {
                name { full }
                languageV2
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { search: q.trim() },
      }),
    });

    if (!response.ok) {
      throw new Error(`AniList returned status ${response.status}`);
    }

    const data = await response.json();
    const media = data?.data?.Page?.media || [];
    const formatted = media.map(formatAniListMediaResult);

    return res.json({ results: formatted });
  } catch (err: any) {
    console.error("AniList search error:", err);
    return res.status(502).json({ error: "Failed to query AniList API.", details: err.message });
  }
});

app.get("/api/anilist/details/:id", async (req: Request, res: Response) => {
  const idNum = parseInt(String(req.params.id || ""), 10);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return res.status(400).json({ error: "Valid positive numeric AniList ID is required." });
  }

  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title { romaji english native }
        description(asHtml: false)
        coverImage { extraLarge large }
        bannerImage
        genres
        seasonYear
        episodes
        status
        isAdult
        studios {
          edges { isMain node { name } }
          nodes { name }
        }
        staff(sort: RELEVANCE, perPage: 12) {
          edges { role node { name { full } } }
        }
        characters(sort: [ROLE, RELEVANCE], perPage: 12) {
          edges {
            role
            node { name { full } image { large medium } }
            voiceActors(sort: RELEVANCE) { name { full } languageV2 }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables: { id: idNum } }),
    });
    if (!response.ok) throw new Error(`AniList returned status ${response.status}`);
    const data = await response.json();
    const m = data?.data?.Media;
    if (!m) return res.status(404).json({ error: "AniList anime not found." });
    return res.json({ anime: formatAniListMediaResult(m) });
  } catch (err: any) {
    return res.status(502).json({ error: "Failed to fetch AniList details.", details: err?.message });
  }
});

// Clean JSON responses for Multer upload errors (size limit / disallowed extension)
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err && (err.name === "MulterError" || /Unsupported upload file type/i.test(String(err.message || "")))) {
    return res.status(400).json({ error: err.message || "Invalid file upload." });
  }
  return next(err);
});

// ==================== VITE & STATIC SERVING ====================

async function startServer() {
  const isProduction = process.env.NODE_ENV === "production";

  if (!isProduction) {
    // Mount Vite dev server middlewares
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production static serving
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`YG Flash Anime Server running on port ${PORT} (dev mode: ${!isProduction})`);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;
}

startServer().catch((err) => {
  console.error("Fatal error starting server:", err);
  process.exit(1);
});
