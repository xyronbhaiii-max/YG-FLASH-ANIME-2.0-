import React, { useState } from "react";
import { AppProvider, useApp } from "./context/AppContext";
import { TopBar } from "./components/TopBar";
import { BottomNav } from "./components/BottomNav";
import { IntroScreen } from "./components/IntroScreen";
import { HomeView } from "./views/HomeView";
import { SearchView } from "./views/SearchView";
import { HistoryView } from "./views/HistoryView";
import { AnimeDetailsView } from "./views/AnimeDetailsView";
import { AdminDashboardView } from "./views/AdminDashboardView";
import { AdminLoginModal } from "./views/AdminLoginModal";
import { ProfileAndSettingsView } from "./views/ProfileAndSettingsView";
import { VideoPlayerModal } from "./views/VideoPlayerModal";

import { OfflineWarningModal } from "./components/OfflineWarningModal";
import { ErrorBoundary } from "./components/ErrorBoundary";

const INTRO_SHOWN_SESSION_KEY = "yg_intro_shown_v1";

const MainAppContent: React.FC = () => {
  const {
    currentView,
    backgroundPosterUrl,
    authReady,
    isAdmin,
    accessDeniedMessage,
    clearAccessDeniedMessage,
    navigateTo,
  } = useApp();

  const [isIntroComplete, setIsIntroComplete] = useState<boolean>(() => {
    try {
      if (typeof window !== "undefined") {
        if (window.location.pathname !== "/" || sessionStorage.getItem(INTRO_SHOWN_SESSION_KEY) === "1") {
          return true;
        }
      }
    } catch {}
    return false;
  });

  const handleIntroComplete = () => {
    try {
      sessionStorage.setItem(INTRO_SHOWN_SESSION_KEY, "1");
    } catch {}
    setIsIntroComplete(true);
  };

  const showBackdropOnView = ["home", "details", "search", "history"].includes(currentView);

  return (
    <div className="min-h-screen text-[var(--text-main)] flex flex-col font-sans relative overflow-x-hidden">
      {/* Ultra-fast startup overlay while MainAppContent mounts & hydrates immediately underneath */}
      {!isIntroComplete && <IntroScreen onComplete={handleIntroComplete} />}

      {/* Offline Alert System */}
      <OfflineWarningModal />

      {/* High-Quality Anime Background Poster Wallpaper (compositor-clean without full-screen CSS filters) */}
      {backgroundPosterUrl && showBackdropOnView && (
        <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden bg-black">
          <img
            src={backgroundPosterUrl}
            alt="Anime Theme Backdrop"
            decoding="async"
            className="w-full h-full object-cover object-center opacity-50 transition-opacity duration-300 ease-out"
            referrerPolicy="no-referrer"
          />
          {/* High-contrast cinematic depth vignette so artwork pops while scrolling stays 60fps */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/30 to-black/85" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_25%,rgba(0,0,0,0.65)_100%)]" />
        </div>
      )}

      <div className="relative z-10 flex flex-col min-h-screen">
        <TopBar />

        {accessDeniedMessage && (
          <div
            role="alert"
            className="max-w-3xl w-[94%] mx-auto mt-3 px-4 py-3 rounded-2xl bg-rose-950/90 border border-rose-500/50 text-rose-200 text-xs font-semibold flex items-center justify-between gap-3 shadow-xl z-30"
          >
            <span>{accessDeniedMessage}</span>
            <button
              type="button"
              onClick={clearAccessDeniedMessage}
              className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/35 text-rose-100 text-[11px] font-bold shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        <main className="flex-1 w-full">
          {currentView === "home" && <HomeView />}
          {currentView === "search" && <SearchView />}
          {currentView === "history" && <HistoryView />}
          {currentView === "details" && <AnimeDetailsView />}
          {currentView === "admin" &&
            (!authReady ? (
              <div className="max-w-md mx-auto p-10 text-center space-y-3">
                <div className="w-8 h-8 mx-auto rounded-full border-2 border-white/20 border-t-[var(--primary)] animate-spin" />
                <p className="text-xs font-semibold text-neutral-300">
                  Verifying Admin Authorization...
                </p>
              </div>
            ) : isAdmin ? (
              <AdminDashboardView />
            ) : (
              <div className="max-w-md mx-auto p-8 text-center space-y-4">
                <p className="text-sm font-bold text-rose-400">
                  Access Denied: Admin privileges are restricted to the authorized owner account.
                </p>
                <button
                  type="button"
                  onClick={() => navigateTo("home")}
                  className="theme-btn-primary px-5 py-2.5 rounded-xl font-bold text-xs"
                >
                  Return to Home
                </button>
              </div>
            ))}
          {currentView === "admin-login" && <AdminLoginModal />}
          {(currentView === "more" || currentView === "settings") && <ProfileAndSettingsView />}
        </main>

        {/* Video Player Modal (Fullscreen 16:9) */}
        <VideoPlayerModal />

        {/* Fixed Bottom Navigation */}
        <BottomNav />
      </div>
    </div>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <MainAppContent />
      </AppProvider>
    </ErrorBoundary>
  );
}
