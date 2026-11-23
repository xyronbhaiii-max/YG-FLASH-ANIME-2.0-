export type StreamKind = "youtube" | "vidmoly" | "hls" | "direct" | "invalid";

export interface StreamClassification {
  kind: StreamKind;
  url: string;
  youtubeId: string | null;
  vidmolyId?: string | null;
  embedUrl?: string | null;
  originalUrl?: string;
  error?: string;
}

const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const VIDMOLY_ID_REGEX = /^[a-zA-Z0-9_-]{6,32}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
]);

const VIDMOLY_HOSTS = new Set([
  "vidmoly.biz",
  "www.vidmoly.biz",
  "vidmoly.me",
  "www.vidmoly.me",
  "vidmoly.to",
  "www.vidmoly.to",
  "vidmoly.net",
  "www.vidmoly.net",
  "vidmoly.io",
  "www.vidmoly.io",
  "vidmoly.cc",
  "www.vidmoly.cc",
  "vidmoly.tv",
  "www.vidmoly.tv",
  "vidmoly.co",
  "www.vidmoly.co",
]);

function unwrapIframeSnippet(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (/^<iframe\b/i.test(trimmed)) {
    const srcMatch = trimmed.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (srcMatch?.[1]) {
      return srcMatch[1].trim();
    }
  }
  return trimmed;
}

function normalizeCandidateUrl(rawUrl: string): string {
  const unwrapped = unwrapIframeSnippet(rawUrl);
  const trimmed = unwrapped.trim();
  if (!trimmed) return "";

  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("blob:")
  ) {
    return trimmed;
  }

  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Handle scheme-less domains like "youtube.com/watch?v=..." or "vidmoly.me/w/..."
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$|\?)/i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return trimmed;
}

export function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (YOUTUBE_HOSTS.has(host)) return true;
  return host.endsWith(".youtube.com") || host.endsWith(".youtube-nocookie.com");
}

export function isVidmolyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (VIDMOLY_HOSTS.has(host)) return true;
  return /(?:^|\.)vidmoly\.[a-z]{2,6}$/i.test(host);
}

/**
 * Extracts a Vidmoly video ID from watch (/w/, /v/, /e/) or embed (/embed-<id>.html, /embed/<id>) URLs.
 */
export function extractVidmolyVideoId(rawUrl: string): string | null {
  const normalized = normalizeCandidateUrl(rawUrl);
  if (!normalized) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalized, "https://ygflash.local");
  } catch {
    return null;
  }

  if (!isVidmolyHost(parsed.hostname)) {
    return null;
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  // 1. /embed-<id>.html or /embed-<id>
  const embedPrefixMatch = parts[0].match(/^embed-(.+?)(?:\.html?)?$/i);
  if (embedPrefixMatch?.[1]) {
    let candidate = embedPrefixMatch[1].replace(/^embed-/i, "");
    // Guard against placeholder "embed-embed.html" redirects
    if (candidate && candidate.toLowerCase() !== "embed" && VIDMOLY_ID_REGEX.test(candidate)) {
      return candidate;
    }
    return null;
  }

  // 2. /w/<id>, /v/<id>, /e/<id>, /embed/<id>
  if (
    parts.length >= 2 &&
    ["w", "v", "e", "embed"].includes(parts[0].toLowerCase())
  ) {
    const candidate = parts[1].replace(/\.html?$/i, "");
    return VIDMOLY_ID_REGEX.test(candidate) ? candidate : null;
  }

  // 3. Direct /<id>.html or /<id>
  if (parts.length === 1) {
    const candidate = parts[0].replace(/\.html?$/i, "");
    const reserved = new Set([
      "login",
      "register",
      "upload",
      "faq",
      "contact",
      "dmca",
      "tos",
      "privacy",
      "make_money",
      "api",
    ]);
    if (!reserved.has(candidate.toLowerCase()) && VIDMOLY_ID_REGEX.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function buildVidmolyEmbedUrl(vidmolyId: string): string {
  // Vidmoly's canonical active HTTPS embed endpoint (vidmoly.to redirects to HTTP ad domains;
  // vidmoly.me/w/* sets X-Frame-Options: SAMEORIGIN and /embed-* mis-redirects).
  return `https://vidmoly.biz/embed-${vidmolyId}.html`;
}

/**
 * Extracts and validates the 11-character YouTube video ID from any YouTube URL format.
 */
export function extractYouTubeVideoId(rawUrl: string): string | null {
  const normalized = normalizeCandidateUrl(rawUrl);
  if (!normalized) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalized, "https://ygflash.local");
  } catch {
    return null;
  }

  if (!isYouTubeHost(parsed.hostname)) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const pathParts = parsed.pathname.split("/").filter(Boolean);

  // 1. youtu.be/<videoId>
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = pathParts[0] || "";
    return YOUTUBE_ID_REGEX.test(id) ? id : null;
  }

  // 2. Attribution links: /attribution_link?u=/watch?v=<videoId>
  if (pathParts[0] === "attribution_link") {
    const inner = parsed.searchParams.get("u");
    if (inner) {
      return extractYouTubeVideoId(`https://www.youtube.com${inner.startsWith("/") ? inner : `/${inner}`}`);
    }
  }

  // 3. Query param v= or vi= (e.g., /watch?v=<videoId>)
  const vParam = parsed.searchParams.get("v") || parsed.searchParams.get("vi");
  if (vParam && YOUTUBE_ID_REGEX.test(vParam.trim())) {
    return vParam.trim();
  }

  // 4. Path formats: /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>, /e/<id>
  if (
    pathParts.length >= 2 &&
    ["embed", "shorts", "live", "v", "e"].includes(pathParts[0].toLowerCase())
  ) {
    const id = pathParts[1];
    if (YOUTUBE_ID_REGEX.test(id)) {
      return id;
    }
  }

  return null;
}

export function isYouTubeUrl(rawUrl?: string | null): boolean {
  if (!rawUrl) return false;
  const normalized = normalizeCandidateUrl(rawUrl);
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("./") || normalized.startsWith("../")) {
    return false;
  }
  try {
    const parsed = new URL(normalized);
    return isYouTubeHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function isHlsStreamUrl(rawUrl?: string | null): boolean {
  if (!rawUrl) return false;
  const normalized = normalizeCandidateUrl(rawUrl);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized, "https://ygflash.local");
    const pathnameLower = parsed.pathname.toLowerCase();
    const searchLower = parsed.search.toLowerCase();
    return (
      pathnameLower.endsWith(".m3u8") ||
      pathnameLower.includes(".m3u8/") ||
      searchLower.includes(".m3u8") ||
      parsed.searchParams.get("format")?.toLowerCase() === "m3u8"
    );
  } catch {
    return /\.m3u8(\?|#|$)/i.test(normalized);
  }
}

export function isBunnyEmbedWebpageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "iframe.mediadelivery.net" ||
    host === "player.mediadelivery.net" ||
    host.endsWith(".mediadelivery.net")
  );
}

/**
 * Classifies a streaming URL separately into YouTube, Vidmoly Embed, HLS (.m3u8), Direct MP4/WebM/MKV, or Invalid.
 */
export function classifyStreamUrl(rawUrl?: string | null): StreamClassification {
  if (!rawUrl || !rawUrl.trim()) {
    return {
      kind: "invalid",
      url: "",
      youtubeId: null,
      error: "No streaming URL provided.",
    };
  }

  const normalized = normalizeCandidateUrl(rawUrl);

  // Allow relative local server uploads & blob URLs directly
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("blob:")
  ) {
    return {
      kind: isHlsStreamUrl(normalized) ? "hls" : "direct",
      url: normalized,
      youtubeId: null,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return {
      kind: "invalid",
      url: normalized,
      youtubeId: null,
      error: "Invalid streaming URL format. Verify the stream URL.",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "invalid",
      url: normalized,
      youtubeId: null,
      error: "Invalid streaming URL protocol. Use an HTTP(S), YouTube, HLS (.m3u8), or Vidmoly link.",
    };
  }

  // 1. Detect YouTube URLs separately from MP4 and HLS URLs
  if (isYouTubeHost(parsed.hostname)) {
    const youtubeId = extractYouTubeVideoId(normalized);
    if (!youtubeId) {
      return {
        kind: "invalid",
        url: normalized,
        youtubeId: null,
        error: "Invalid YouTube URL. Please provide a valid YouTube video, Shorts, Live, or Embed link.",
      };
    }
    return {
      kind: "youtube",
      url: normalized,
      youtubeId,
    };
  }

  // 2. Detect Vidmoly watch/embed URLs (avoid misrouting HTML embed pages into <video>)
  if (isVidmolyHost(parsed.hostname)) {
    // Allow direct CDN media files hosted on a vidmoly subdomain (.m3u8 or .mp4) to play cleanly
    if (isHlsStreamUrl(normalized)) {
      return {
        kind: "hls",
        url: normalized,
        youtubeId: null,
      };
    }
    if (/\.(?:mp4|webm|mkv|mov)(\?|#|$)/i.test(parsed.pathname)) {
      return {
        kind: "direct",
        url: normalized,
        youtubeId: null,
      };
    }

    const vidmolyId = extractVidmolyVideoId(normalized);
    if (!vidmolyId) {
      return {
        kind: "invalid",
        url: normalized,
        youtubeId: null,
        vidmolyId: null,
        error:
          "Invalid Vidmoly URL. Provide a valid Vidmoly video link (e.g., https://vidmoly.biz/embed-VIDEOID.html or https://vidmoly.me/w/VIDEOID).",
      };
    }

    const embedUrl = buildVidmolyEmbedUrl(vidmolyId);
    return {
      kind: "vidmoly",
      url: embedUrl,
      embedUrl,
      originalUrl: normalized,
      youtubeId: null,
      vidmolyId,
    };
  }

  // 3. Guard Bunny Stream iframe webpage URLs when an HLS playlist URL (.m3u8) is expected
  if (isBunnyEmbedWebpageHost(parsed.hostname) && !isHlsStreamUrl(normalized)) {
    return {
      kind: "invalid",
      url: normalized,
      youtubeId: null,
      error:
        "Bunny Stream iframe webpage links cannot play inside the adaptive HLS player. Paste the Bunny Stream HLS Playlist URL ending in playlist.m3u8 (from Bunny Stream -> Video -> HLS Playlist URL).",
    };
  }

  // 4. Detect HLS (.m3u8) streams (including Bunny Stream CDN & tokenized .m3u8 URLs)
  if (isHlsStreamUrl(normalized)) {
    return {
      kind: "hls",
      url: normalized,
      youtubeId: null,
    };
  }

  // 5. Direct MP4 / WebM / MKV / CDN media URL
  return {
    kind: "direct",
    url: normalized,
    youtubeId: null,
  };
}

export function getStreamMimeType(rawUrl?: string | null): string {
  const classified = classifyStreamUrl(rawUrl);
  if (classified.kind === "youtube") return "video/youtube";
  if (classified.kind === "vidmoly") return "embed/vidmoly";
  if (classified.kind === "hls") return "application/x-mpegURL";
  return "video/mp4";
}
