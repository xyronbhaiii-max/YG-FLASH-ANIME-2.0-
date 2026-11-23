import React, { useEffect, useImperativeHandle, useState, forwardRef } from "react";
import { apiUrl } from "../utils/apiUrl";

export interface VidmolyPlayerHandle {
  reload: () => void;
}

interface VidmolyPlayerProps {
  embedUrl: string;
  vidmolyId: string;
  onBufferingChange: (buffering: boolean) => void;
  onReady?: () => void;
  onError: (message: string, code?: string) => void;
}

export const VidmolyPlayer = forwardRef<VidmolyPlayerHandle, VidmolyPlayerProps>(
  ({ embedUrl, vidmolyId, onBufferingChange, onReady, onError }, ref) => {
    const [reloadKey, setReloadKey] = useState<number>(0);
    const [iframeLoaded, setIframeLoaded] = useState<boolean>(false);
    const [preflightVerified, setPreflightVerified] = useState<boolean>(false);

    const latestCallbacksRef = React.useRef({
      onBufferingChange,
      onReady,
      onError,
    });
    latestCallbacksRef.current = {
      onBufferingChange,
      onReady,
      onError,
    };

    useImperativeHandle(ref, () => ({
      reload: () => {
        setIframeLoaded(false);
        setPreflightVerified(false);
        latestCallbacksRef.current.onBufferingChange(true);
        setReloadKey((k) => k + 1);
      },
    }));

    useEffect(() => {
      if (!embedUrl) return;
      let cancelled = false;
      setIframeLoaded(false);
      setPreflightVerified(false);
      latestCallbacksRef.current.onBufferingChange(true);

      const ctrl = new AbortController();
      let timedOut = false;
      const fetchTimeout = window.setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, 7500);

      // Read-only server header/availability check (detects 404, conflicting X-Frame-Options, CSP frame-ancestors, or domain hijacks)
      fetch(apiUrl(`/api/stream/embed-check?url=${encodeURIComponent(embedUrl)}`), {
        signal: ctrl.signal,
      })
        .then(async (res) => {
          window.clearTimeout(fetchTimeout);
          if (cancelled) return;
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            latestCallbacksRef.current.onBufferingChange(false);
            if (res.status === 400) {
              latestCallbacksRef.current.onError(
                data?.error || "Invalid Vidmoly embed URL.",
                "INVALID_EMBED_URL"
              );
            } else {
              latestCallbacksRef.current.onError(
                data?.error || `Vidmoly preflight check failed (HTTP ${res.status}).`,
                `PREFLIGHT_HTTP_${res.status}`
              );
            }
            return;
          }
          const data = await res.json().catch(() => null);
          if (cancelled) return;
          if (!data) {
            latestCallbacksRef.current.onBufferingChange(false);
            latestCallbacksRef.current.onError(
              "Unable to verify Vidmoly embed headers.",
              "PREFLIGHT_INVALID_RESPONSE"
            );
            return;
          }
          if (data.embeddable === false) {
            latestCallbacksRef.current.onBufferingChange(false);
            latestCallbacksRef.current.onError(
              data.reason ||
                "Vidmoly refused embedding or this video is unavailable in the current environment.",
              data.code || "EMBED_BLOCKED"
            );
            return;
          }
          setPreflightVerified(true);
        })
        .catch(() => {
          window.clearTimeout(fetchTimeout);
          if (cancelled) return;
          latestCallbacksRef.current.onBufferingChange(false);
          latestCallbacksRef.current.onError(
            timedOut
              ? "Timed out connecting to Vidmoly embed verification service."
              : "Network error verifying Vidmoly embed availability.",
            timedOut ? "NETWORK_TIMEOUT" : "NETWORK_ERROR"
          );
        });

      return () => {
        cancelled = true;
        window.clearTimeout(fetchTimeout);
        ctrl.abort();
      };
    }, [embedUrl, vidmolyId, reloadKey]);

    // Safety timeout if browser client CSP / adblocker silently blocks the third-party iframe from firing onLoad
    useEffect(() => {
      if (!preflightVerified || iframeLoaded) return;
      const timer = window.setTimeout(() => {
        if (!iframeLoaded) {
          latestCallbacksRef.current.onBufferingChange(false);
          latestCallbacksRef.current.onError(
            "Vidmoly player timed out or embedding was blocked by your browser/network settings.",
            "IFRAME_TIMEOUT"
          );
        }
      }, 14000);
      return () => window.clearTimeout(timer);
    }, [preflightVerified, iframeLoaded, embedUrl, reloadKey]);

    useEffect(() => {
      if (iframeLoaded && preflightVerified) {
        latestCallbacksRef.current.onBufferingChange(false);
        latestCallbacksRef.current.onReady?.();
      }
    }, [iframeLoaded, preflightVerified]);

    return (
      <div
        className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden"
        data-vidmoly-player="true"
        data-vidmoly-id={vidmolyId}
      >
        {preflightVerified ? (
          <iframe
            key={`${embedUrl}::${reloadKey}`}
            src={embedUrl}
            title={`Vidmoly Player (${vidmolyId})`}
            className="w-full h-full border-0 bg-black pointer-events-auto"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer-when-downgrade"
            onLoad={() => {
              setIframeLoaded(true);
              latestCallbacksRef.current.onBufferingChange(false);
              latestCallbacksRef.current.onReady?.();
            }}
            onError={() => {
              latestCallbacksRef.current.onBufferingChange(false);
              latestCallbacksRef.current.onError(
                "Unable to load Vidmoly embedded player. Embedding may be restricted or the video may be unavailable.",
                "IFRAME_LOAD_ERROR"
              );
            }}
          />
        ) : null}
      </div>
    );
  }
);

VidmolyPlayer.displayName = "VidmolyPlayer";
