export const VIDEO_QUALITIES = [
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
] as const;

export type VideoQualityCode = (typeof VIDEO_QUALITIES)[number];

export interface VideoQualityMeta {
  code: VideoQualityCode;
  shortLabel: string;
  fullLabel: string;
  rank: number;
}

export const VIDEO_QUALITY_META: Record<VideoQualityCode, VideoQualityMeta> = {
  "2160p": { code: "2160p", shortLabel: "2160p 4K", fullLabel: "2160p 4K UHD", rank: 6 },
  "1440p": { code: "1440p", shortLabel: "1440p 2K", fullLabel: "1440p 2K QHD", rank: 5 },
  "1080p": { code: "1080p", shortLabel: "1080p FHD", fullLabel: "1080p Full HD", rank: 4 },
  "720p": { code: "720p", shortLabel: "720p HD", fullLabel: "720p HD", rank: 3 },
  "480p": { code: "480p", shortLabel: "480p", fullLabel: "480p SD", rank: 2 },
  "360p": { code: "360p", shortLabel: "360p", fullLabel: "360p Low", rank: 1 },
};

export function normalizeQualityCode(raw?: string | null): string {
  const clean = String(raw || "").trim();
  if (!clean) return "1080p";
  const lower = clean.toLowerCase();
  if (lower.includes("2160") || lower === "4k" || lower.includes("uhd")) return "2160p";
  if (lower.includes("1440") || lower === "2k" || lower.includes("qhd")) return "1440p";
  if (lower.includes("1080") || lower === "fhd" || lower.includes("full hd")) return "1080p";
  if (lower.includes("720") || lower === "hd") return "720p";
  if (lower.includes("480") || lower === "sd") return "480p";
  if (lower.includes("360")) return "360p";
  return clean;
}

export function getQualityRank(raw?: string | null): number {
  const norm = normalizeQualityCode(raw) as VideoQualityCode;
  return VIDEO_QUALITY_META[norm]?.rank ?? 0;
}

export function getQualityDisplayLabel(raw?: string | null): string {
  const norm = normalizeQualityCode(raw) as VideoQualityCode;
  return VIDEO_QUALITY_META[norm]?.fullLabel || String(raw || "Source");
}

export function sortSourcesByQuality<T extends { quality?: string; label?: string; name?: string }>(
  list: T[]
): T[] {
  return [...list].sort(
    (a, b) =>
      getQualityRank(b.quality || b.label || b.name) -
      getQualityRank(a.quality || a.label || a.name)
  );
}
