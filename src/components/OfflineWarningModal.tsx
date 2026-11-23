import React, { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, CheckCircle, Radio, Wifi } from "lucide-react";
import { Network } from "@capacitor/network";
import { sound } from "../utils/sound";
import { apiUrl, isCapacitorNative } from "../utils/apiUrl";
import { OFFLINE_GHOST_IMAGE } from "../assets/offlineGhostData";

type OfflineReason = "off" | "no-data" | null;
type PingResult = "ok" | "timeout" | "fail";

export const OfflineWarningModal: React.FC = () => {
  const [offlineReason, setOfflineReason] = useState<OfflineReason>(null);
  const [slowNetworkBanner, setSlowNetworkBanner] = useState<boolean>(false);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [restoredToast, setRestoredToast] = useState<boolean>(false);
  const wasOfflineRef = useRef<boolean>(false);
  const isOfflineRef = useRef<boolean>(false);
  const isCheckingRef = useRef<boolean>(false);
  const isUploadingRef = useRef<boolean>(false);
  const lastUploadPulseRef = useRef<number>(0);

  const isOffline = offlineReason !== null;
  isOfflineRef.current = isOffline;

  // Pause any active playback so users cannot watch cached fragments when net is dead/no recharge
  const pauseActiveStreams = useCallback(() => {
    try {
      document.querySelectorAll("video").forEach((v) => {
        if (!v.paused) v.pause();
      });
      window.dispatchEvent(new Event("yg:offline-pause"));
    } catch {}
  }, []);

  // Single HTTP JSON probe against our own server (distinguishes slow AbortError timeouts from hard failures)
  const pingServerOnce = useCallback(async (timeoutMs: number): Promise<PingResult> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(apiUrl(`/api/ping?t=${Date.now()}`), {
        method: "GET",
        cache: "no-store",
        credentials: "include",
        headers: {
          "Cache-Control": "no-cache, no-store",
          Pragma: "no-cache",
        },
        signal: controller.signal,
      });

      const contentType = res.headers.get("content-type") || "";
      if (!res.ok || !contentType.includes("application/json")) {
        return "fail";
      }

      const data = await res.json();
      return data && data.ok === true ? "ok" : "fail";
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return "timeout";
      }
      return "fail";
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  // Active live internet reachability probe (keeps slow mobile data streaming with buffering notice instead of false lockout)
  const checkRealConnectivity = useCallback(
    async (options?: { showRestoredToast?: boolean; immediateOnFail?: boolean }): Promise<boolean> => {
      if (isCheckingRef.current) return !wasOfflineRef.current;
      isCheckingRef.current = true;

      try {
        if (isUploadingRef.current && Date.now() - lastUploadPulseRef.current < 15000) {
          return true;
        }

        const timeoutMs = !navigator.onLine ? 2500 : isUploadingRef.current ? 12000 : 8000;
        const firstTry = await pingServerOnce(timeoutMs);

        if (firstTry === "ok") {
          setSlowNetworkBanner(false);
          if (wasOfflineRef.current) {
            wasOfflineRef.current = false;
            setOfflineReason(null);
            window.dispatchEvent(new CustomEvent("yg:network-restored"));
            if (options?.showRestoredToast !== false) {
              sound.playSuccess();
              setRestoredToast(true);
              setTimeout(() => setRestoredToast(false), 3200);
            }
          } else {
            setOfflineReason(null);
          }
          return true;
        }

        // If browser says online and probe simply timed out on slow 2G/3G, allow streaming & show buffering banner
        if (firstTry === "timeout" && navigator.onLine && !isOfflineRef.current) {
          wasOfflineRef.current = false;
          setOfflineReason(null);
          setSlowNetworkBanner(true);
          return true;
        }

        if (!options?.immediateOnFail) {
          await new Promise((r) => setTimeout(r, 900));
          if (isUploadingRef.current && Date.now() - lastUploadPulseRef.current < 15000) {
            return true;
          }
          const secondTry = await pingServerOnce(timeoutMs);
          if (secondTry === "ok") {
            setSlowNetworkBanner(false);
            if (wasOfflineRef.current) {
              wasOfflineRef.current = false;
              setOfflineReason(null);
              window.dispatchEvent(new CustomEvent("yg:network-restored"));
              if (options?.showRestoredToast !== false) {
                sound.playSuccess();
                setRestoredToast(true);
                setTimeout(() => setRestoredToast(false), 3200);
              }
            } else {
              setOfflineReason(null);
            }
            return true;
          }

          if (secondTry === "timeout" && navigator.onLine && !isOfflineRef.current) {
            wasOfflineRef.current = false;
            setOfflineReason(null);
            setSlowNetworkBanner(true);
            return true;
          }
        }

        // Genuine offline state or dead/no-data connection
        const nextReason: OfflineReason = navigator.onLine ? "no-data" : "off";
        setSlowNetworkBanner(false);
        if (!wasOfflineRef.current) sound.playError();
        wasOfflineRef.current = true;
        setOfflineReason(nextReason);
        pauseActiveStreams();
        return false;
      } finally {
        isCheckingRef.current = false;
      }
    },
    [pauseActiveStreams, pingServerOnce]
  );

  useEffect(() => {
    const handleOnline = () => {
      checkRealConnectivity({ showRestoredToast: true });
    };

    const handleOffline = () => {
      // Confirm with a fast ping so WebView quirks don't falsely lock the app when data still works
      checkRealConnectivity({ showRestoredToast: true });
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        checkRealConnectivity({ showRestoredToast: true });
      }
    };

    const handleCustomNetworkCheck = () => {
      checkRealConnectivity({ showRestoredToast: true });
    };

    const handleUploadState = (e: Event) => {
      const active = Boolean((e as CustomEvent)?.detail?.active);
      isUploadingRef.current = active;
      if (active) lastUploadPulseRef.current = Date.now();
    };

    const handleUploadPulse = () => {
      lastUploadPulseRef.current = Date.now();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("yg:network-check", handleCustomNetworkCheck);
    window.addEventListener("yg:upload-state", handleUploadState);
    window.addEventListener("yg:upload-pulse", handleUploadPulse);

    const conn = (navigator as any).connection;
    if (conn && typeof conn.addEventListener === "function") {
      conn.addEventListener("change", handleOnline);
    }

    // Immediate startup reachability check (non-blocking initial state)
    checkRealConnectivity({ showRestoredToast: false });

    // Adaptive background heartbeat: 4s recovery check while offline, 12s gentle check while online
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleNextHeartbeat = () => {
      if (disposed) return;
      const delay = isOfflineRef.current ? 4000 : 12000;
      timerId = setTimeout(async () => {
        if (disposed) return;
        if (document.visibilityState === "visible") {
          await checkRealConnectivity({ showRestoredToast: true });
        }
        scheduleNextHeartbeat();
      }, delay);
    };

    scheduleNextHeartbeat();

    let removeCapNetworkListener: (() => void) | null = null;
    if (isCapacitorNative()) {
      Network.addListener("networkStatusChange", () => {
        checkRealConnectivity({ showRestoredToast: true });
      })
        .then((handle) => {
          if (disposed) {
            handle.remove().catch(() => {});
          } else {
            removeCapNetworkListener = () => handle.remove().catch(() => {});
          }
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      if (timerId) clearTimeout(timerId);
      removeCapNetworkListener?.();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("yg:network-check", handleCustomNetworkCheck);
      window.removeEventListener("yg:upload-state", handleUploadState);
      window.removeEventListener("yg:upload-pulse", handleUploadPulse);
      if (conn && typeof conn.removeEventListener === "function") {
        conn.removeEventListener("change", handleOnline);
      }
    };
  }, [checkRealConnectivity]);

  const handleManualCheck = async () => {
    setIsChecking(true);
    sound.playClick();
    const ok = await checkRealConnectivity({ showRestoredToast: true, immediateOnFail: true });
    if (!ok) {
      sound.playError();
    }
    setTimeout(() => setIsChecking(false), 500);
  };

  // Toast notification when connection returns
  if (restoredToast && !isOffline) {
    return (
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2.5 rounded-2xl bg-emerald-950/90 border border-emerald-500/50 shadow-2xl flex items-center gap-2.5 text-xs font-bold text-white backdrop-blur-md">
        <CheckCircle className="w-4 h-4 text-emerald-400" />
        <span>Back Online! High-Speed Streaming Restored.</span>
      </div>
    );
  }

  // Non-blocking notice when online but signal is slow (allows video playback & buffering without locking the app)
  if (slowNetworkBanner && !isOffline) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed top-3 left-1/2 -translate-x-1/2 z-[9998] px-3.5 py-2 rounded-2xl bg-amber-950/92 border border-amber-500/45 shadow-xl flex items-center gap-2 text-[11px] sm:text-xs font-semibold text-amber-100 max-w-[92vw]"
      >
        <Wifi className="w-3.5 h-3.5 text-amber-400 shrink-0 animate-pulse" />
        <span className="truncate">Slow internet detected</span>
      </div>
    );
  }

  if (!isOffline) {
    return null;
  }

  const isNoDataPlan = offlineReason === "no-data";

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/95 backdrop-blur-md select-none animate-fadeIn">
      {/* Ambient Red/Orange Warning Glow */}
      <div className="absolute w-80 h-80 rounded-full bg-rose-600/20 blur-3xl pointer-events-none" />

      <div className="relative max-w-sm w-full p-6 rounded-3xl bg-[var(--bg-card)] border-2 border-rose-500/50 shadow-2xl shadow-rose-950/60 text-center space-y-5 overflow-hidden">
        {/* User's Shared Ghost Offline Graphic (Embedded Offline-First Base64) */}
        <div className="relative mx-auto w-36 h-36 rounded-2xl overflow-hidden border border-rose-500/40 shadow-lg shadow-rose-950/50 bg-black flex items-center justify-center">
          <img
            src={OFFLINE_GHOST_IMAGE}
            alt="Ghost Offline Warning"
            className="w-full h-full object-contain animate-pulse"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent pointer-events-none" />
        </div>

        {/* Text Warning */}
        <div className="space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-extrabold uppercase bg-rose-500/20 text-rose-300 border border-rose-500/40 tracking-wider">
            <Radio className="w-3 h-3 text-rose-400 animate-ping" />
            <span>
              {isNoDataPlan
                ? "No Internet Access · Low / No Data"
                : "Connection Dropped"}
            </span>
          </div>

          <h2 className="text-xl sm:text-2xl font-black text-white tracking-wider uppercase">
            YOU ARE OFFLINE
          </h2>

          <p className="text-xs text-[var(--text-muted)] leading-relaxed px-2">
            Please check your internet connection and try again.
            {isNoDataPlan
              ? " Active Wi-Fi or mobile data is connected without internet access."
              : ""}
          </p>
        </div>

        {/* Retry Button (Strictly Non-Dismissible) */}
        <div className="pt-2">
          <button
            type="button"
            disabled={isChecking}
            onClick={handleManualCheck}
            className="theme-btn-primary w-full h-12 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-2 active:scale-95 transition-transform shadow-lg"
          >
            <RefreshCw className={`w-4 h-4 ${isChecking ? "animate-spin" : ""}`} />
            <span>{isChecking ? "Testing Connection..." : "Check Connection & Retry"}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
