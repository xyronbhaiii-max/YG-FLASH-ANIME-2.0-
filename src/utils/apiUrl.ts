export const DEFAULT_NATIVE_API_BASE_URL =
  "https://ais-pre-d3fcmcsrrwmaklp5aczaab-204390072266.asia-northeast1.run.app";

export function isCapacitorNative(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as any).Capacitor;
  if (!cap) return false;
  if (typeof cap.isNativePlatform === "function") {
    return Boolean(cap.isNativePlatform());
  }
  const protocol = window.location?.protocol || "";
  const host = window.location?.hostname || "";
  return protocol === "capacitor:" || (protocol === "https:" && host === "localhost" && Boolean(cap.platform && cap.platform !== "web"));
}

export function getCapacitorPlatform(): "android" | "ios" | "web" {
  if (typeof window === "undefined") return "web";
  const cap = (window as any).Capacitor;
  if (cap && typeof cap.getPlatform === "function") {
    const p = cap.getPlatform();
    if (p === "android" || p === "ios") return p;
  }
  return "web";
}

export function getApiBaseUrl(): string {
  const envUrl = String(import.meta.env.VITE_API_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");

  if (envUrl) {
    return envUrl;
  }

  if (isCapacitorNative()) {
    try {
      const override = localStorage.getItem("yg_api_base_url")?.trim().replace(/\/+$/, "");
      if (override) return override;
    } catch {}
    return DEFAULT_NATIVE_API_BASE_URL;
  }

  return "";
}

export function apiUrl(path: string): string {
  if (!path) return path;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized.startsWith("/api/") || normalized.startsWith("/uploads/")) {
    const base = getApiBaseUrl();
    return base ? `${base}${normalized}` : normalized;
  }
  return path;
}

export function resolveMediaUrl(url: string | undefined | null): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/uploads/")) {
    return apiUrl(trimmed);
  }
  return trimmed;
}
