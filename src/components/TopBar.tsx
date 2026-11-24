import React from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { useApp } from "../context/AppContext";
import { BLINK_STAR_IMAGE, BRAND_LOGO_IMAGE } from "../assets/brandAssetsData";

export const TopBar: React.FC = () => {
  const {
    currentView,
    goBack,
    navigateTo,
    profilePicture,
    displayName,
    isAdmin,
  } = useApp();

  const isSecondaryPage = ["details", "admin", "admin-login", "settings", "search", "history"].includes(
    currentView
  );

  return (
    <header className="sticky top-0 z-40 w-full glass-panel border-b border-[var(--border-subtle)] px-4 py-2.5 transition-colors">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        {/* Zone 1: Brand Zone or Back Arrow */}
        <div className="flex items-center gap-3 shrink-0">
          {isSecondaryPage ? (
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to previous screen"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-white active:scale-95 transition-colors duration-100"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => navigateTo("home")}
              className="flex items-center gap-2.5 text-left group focus:outline-none"
            >
              <div className="relative w-9 h-9 rounded-xl ring-1 ring-white/10 group-hover:ring-[var(--primary)] transition-colors duration-100 animate-logo-aura">
                <div className="w-full h-full rounded-xl overflow-hidden">
                  <img
                    src={BRAND_LOGO_IMAGE}
                    alt="YG Flash Logo"
                    className="w-full h-full object-cover"
                  />
                </div>
                {/* Background-Removed Red Star Blinking Animation on Logo Side */}
                <img
                  src={BLINK_STAR_IMAGE}
                  alt=""
                  aria-hidden="true"
                  className="absolute -top-2 -right-2 w-5 h-5 object-contain pointer-events-none select-none animate-star-blink"
                />
              </div>
              <span className="text-base font-extrabold tracking-tight text-white whitespace-nowrap">
                YG <span className="text-[var(--primary)]">FLASH</span>
              </span>
            </button>
          )}
        </div>

        {/* Zone 2: Navigation Links (Desktop) & Center Title (Mobile) */}
        <div className="flex-1 flex items-center justify-center">
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-[var(--text-muted)]">
            <button
              type="button"
              onClick={() => navigateTo("home")}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                currentView === "home" ? "text-white font-semibold" : ""
              }`}
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => navigateTo("search")}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                currentView === "search" ? "text-white font-semibold" : ""
              }`}
            >
              Browse
            </button>
            <button
              type="button"
              onClick={() => navigateTo("history")}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                currentView === "history" ? "text-white font-semibold" : ""
              }`}
            >
              History
            </button>
          </nav>

          {isSecondaryPage && (
            <span className="md:hidden text-sm font-bold text-white capitalize truncate max-w-[180px]">
              {currentView === "details"
                ? "Anime Details"
                : currentView === "admin"
                ? "Admin Dashboard"
                : currentView === "admin-login"
                ? "Admin Access"
                : currentView === "search"
                ? "Search Catalog"
                : currentView === "history"
                ? "Watch History"
                : "Settings"}
            </span>
          )}
        </div>

        {/* Zone 3: Primary Action / User Profile */}
        <div className="flex items-center gap-2.5 shrink-0">
          {isAdmin && (
            <button
              type="button"
              onClick={() => navigateTo("admin")}
              title="Admin Dashboard"
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors whitespace-nowrap"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Admin</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => navigateTo("more")}
            aria-label="User Profile and Settings"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl p-0.5 hover:ring-2 hover:ring-[var(--primary)] transition-colors duration-100"
          >
            <div className="w-8 h-8 rounded-lg overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              {profilePicture ? (
                <img
                  src={profilePicture}
                  alt={displayName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <img
                  src={BRAND_LOGO_IMAGE}
                  alt="Default Avatar"
                  className="w-full h-full object-cover"
                />
              )}
            </div>
          </button>
        </div>
      </div>
    </header>
  );
};
