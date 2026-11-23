export const AGE_RATING_PRESETS = ["5+", "7+", "10+", "13+", "16+", "18+"] as const;

export type AgeRatingPreset = (typeof AGE_RATING_PRESETS)[number];

/**
 * Extracts a numeric minimum age from standard ("5+".."18+"), legacy ("G", "PG-13", "R17+", "R18+"),
 * or custom age rating labels.
 */
export function parseAgeRatingMinimum(rating?: string | null): number {
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

/**
 * Mature / adult ratings (16+, 18+, R17+, R18+, NC-17, or custom numeric >= 16)
 * are filtered when Safe Mode / Age Filter is active.
 */
export function isRestrictedMatureRating(rating?: string | null): boolean {
  const clean = String(rating || "").trim();
  if (!clean) return false;
  const upper = clean.toUpperCase();
  if (upper === "R17+" || upper === "R18+" || upper === "NC-17" || upper === "ADULT") {
    return true;
  }
  return parseAgeRatingMinimum(clean) >= 16;
}

export function isValidAgeRating(rating?: string | null): boolean {
  const clean = String(rating || "").trim();
  return clean.length >= 1 && clean.length <= 32;
}

export function formatAgeRatingLabel(rating?: string | null): string {
  const clean = String(rating || "").trim();
  if (!clean) return "Unrated";
  switch (clean) {
    case "5+":
      return "5+ (Young Kids)";
    case "7+":
      return "7+ (Older Kids)";
    case "10+":
      return "10+ (Family)";
    case "13+":
      return "13+ (Teens)";
    case "16+":
      return "16+ (Mature)";
    case "18+":
      return "18+ (Adults Only)";
    case "G":
      return "G (All Ages)";
    case "PG-13":
      return "PG-13 (Teens)";
    case "R17+":
      return "R17+ (Mature)";
    case "R18+":
      return "R18+ (Adults)";
    default:
      return clean;
  }
}
