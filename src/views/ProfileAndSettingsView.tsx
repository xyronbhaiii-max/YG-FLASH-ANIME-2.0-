import React, { useState, useRef, useEffect } from "react";
import {
  ArrowLeft,
  Camera,
  Shield,
  Palette,
  Volume2,
  Send,
  Check,
  ChevronRight,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Smartphone,
  Trash2,
  ExternalLink,
  Edit2,
  X,
  User,
  Sun,
  Moon,
  Monitor,
  Cloud,
  LogIn,
  LogOut,
  Fingerprint,
} from "lucide-react";
import { useApp, ThemeType, ThemeMode } from "../context/AppContext";
import { auth } from "../lib/firebase";
import { sound, SoundPack } from "../utils/sound";
import { BLINK_STAR_IMAGE, BRAND_LOGO_IMAGE } from "../assets/brandAssetsData";

export const ProfileAndSettingsView: React.FC = () => {
  const {
    goBack,
    theme,
    setTheme,
    themeMode,
    setThemeMode,
    resolvedMode,
    themeSyncError,
    clearThemeSyncError,
    safeMode,
    setSafeMode,
    soundEnabled,
    setSoundEnabled,
    soundPack,
    setSoundPack,
    userId,
    authUser,
    isProfileSyncedToCloud,
    signInWithGoogle,
    signOutUser,
    profilePicture,
    setProfilePicture,
    displayName,
    setDisplayName,
    isAdmin,
    navigateTo,
  } = useApp();
  const [authBusy, setAuthBusy] = useState<boolean>(false);
  const [authMsg, setAuthMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Subpage navigation within Settings (purely online, no local apk download)
  const [activeSection, setActiveSection] = useState<
    "main" | "theme" | "audio" | "profile"
  >("main");

  // Custom Username editing states
  const [isEditingName, setIsEditingName] = useState<boolean>(false);
  const [customNameInput, setCustomNameInput] = useState<string>(displayName);
  const [nameSuccessToast, setNameSuccessToast] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditingName) {
      setCustomNameInput(displayName);
    }
  }, [displayName, isEditingName]);

  const handleSaveUsername = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = customNameInput.trim().slice(0, 32);
    if (!trimmed) return;
    await setDisplayName(trimmed);
    setIsEditingName(false);
    setNameSuccessToast(`Username updated to "${trimmed}"!`);
    setTimeout(() => setNameSuccessToast(null), 3000);
  };

  const compressAvatarFile = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read selected image."));
      reader.onload = () => {
        const raw = reader.result as string;
        if (!raw) {
          reject(new Error("Empty image data."));
          return;
        }
        const img = new Image();
        img.onerror = () => resolve(raw);
        img.onload = () => {
          const maxDim = 512;
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(raw);
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          let out = canvas.toDataURL("image/jpeg", 0.84);
          if (out.length > 420000) {
            out = canvas.toDataURL("image/jpeg", 0.65);
          }
          resolve(out);
        };
        img.src = raw;
      };
      reader.readAsDataURL(file);
    });

  // Profile Picture Upload Handler (always resets file input & compresses large photos)
  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      sound.playError();
      setAuthMsg("Please choose a valid image file (PNG, JPEG, WebP, or GIF).");
      return;
    }

    sound.playClick();
    try {
      const compressed = await compressAvatarFile(file);
      if (compressed.length > 490000) {
        sound.playError();
        setAuthMsg("Selected image is too large. Please pick a smaller photo.");
        return;
      }
      setProfilePicture(compressed);
      sound.playSuccess();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (auth.currentUser && auth.currentUser.uid === userId) {
        try {
          const token = await auth.currentUser.getIdToken();
          if (token) headers.Authorization = `Bearer ${token}`;
        } catch {}
      }
      await fetch("/api/user/profile-picture", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ userId, pictureBase64: compressed }),
      });
    } catch (err) {
      console.error("Failed to sync picture to server:", err);
    }
  };

  const handleRemovePhoto = async () => {
    sound.playClick();
    setProfilePicture(null);
    try {
      const headers: Record<string, string> = {};
      if (auth.currentUser && auth.currentUser.uid === userId) {
        try {
          const token = await auth.currentUser.getIdToken();
          if (token) headers.Authorization = `Bearer ${token}`;
        } catch {}
      }
      await fetch(`/api/user/profile-picture?userId=${encodeURIComponent(userId)}`, {
        method: "DELETE",
        credentials: "include",
        headers,
      });
    } catch {}
  };

  const handleGoogleAccountToggle = async () => {
    setAuthBusy(true);
    setAuthMsg(null);
    try {
      if (authUser) {
        await signOutUser();
        setAuthMsg("Signed out of Google account. Your device profile & settings stay active.");
      } else {
        await signInWithGoogle();
        setAuthMsg("Google account linked! Profile, favorites, watchlist & theme synced to Cloud Firestore.");
      }
    } catch (err: any) {
      const code = err?.code || "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        setAuthMsg("Sign-in canceled. Tap Link Google Account again when ready.");
      } else if (code === "auth/network-request-failed") {
        setAuthMsg("Network error while connecting to Google. Check your connection and try again.");
      } else if (code === "auth/unauthorized-domain") {
        setAuthMsg("This domain is not authorized for Google Sign-In yet.");
      } else if (code === "auth/popup-blocked") {
        setAuthMsg("Browser blocked the Google sign-in popup. Redirecting or allow popups to sign in.");
      } else {
        setAuthMsg(err?.message || "Could not complete account sign-in.");
      }
    } finally {
      setAuthBusy(false);
    }
  };

  // Subpage Back Arrow
  const handleSubpageBack = () => {
    sound.playNavigate();
    if (activeSection !== "main") {
      setActiveSection("main");
    } else {
      goBack();
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-4 md:py-8 space-y-6 pb-28">
      {/* Top Header */}
      <div className="flex items-center gap-3 pb-4 border-b border-[var(--border-subtle)]">
        <button
          type="button"
          onClick={handleSubpageBack}
          aria-label="Back"
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-white active:scale-95 transition-all"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white">
            {activeSection === "theme"
              ? "Theme Engine"
              : activeSection === "audio"
              ? "UI Sound Engine"
              : activeSection === "profile"
              ? "Custom Profile Picture"
              : "Settings & Profile"}
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            YG Flash Anime · Customization & System Controls
          </p>
        </div>
      </div>

      {/* Main Settings Navigation */}
      {activeSection === "main" && (
        <div className="space-y-6">
          {/* Profile Card with Custom Gallery Picture */}
          <div className="p-6 rounded-3xl bg-[var(--bg-card)] border border-[var(--border-subtle)] flex flex-col sm:flex-row items-center gap-5 shadow-lg">
            <div className="relative group">
              <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-md animate-logo-aura">
                {profilePicture ? (
                  <img
                    src={profilePicture}
                    alt={displayName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <img
                    src={BRAND_LOGO_IMAGE}
                    alt="Default Mascot"
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
              {/* Background-Removed Red Star Blinking Animation on Logo Side */}
              {!profilePicture && (
                <img
                  src={BLINK_STAR_IMAGE}
                  alt=""
                  aria-hidden="true"
                  className="absolute -top-2.5 -left-2.5 w-6 h-6 object-contain pointer-events-none select-none z-10 animate-star-blink"
                />
              )}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Change Profile Picture"
                className="absolute -bottom-1.5 -right-1.5 w-8 h-8 rounded-full bg-[var(--primary)] text-white flex items-center justify-center shadow-lg active:scale-90 transition-transform"
              >
                <Camera className="w-4 h-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handlePhotoSelect}
              />
            </div>

            <div className="text-center sm:text-left flex-1 min-w-0">
              {/* Username row / Edit form */}
              {isEditingName ? (
                <form onSubmit={handleSaveUsername} className="flex flex-col sm:flex-row items-center gap-2 mb-1">
                  <div className="relative w-full sm:w-auto">
                    <input
                      type="text"
                      autoFocus
                      maxLength={32}
                      value={customNameInput}
                      onChange={(e) => setCustomNameInput(e.target.value)}
                      placeholder="Enter username..."
                      className="h-9 px-3 pr-8 rounded-xl bg-[var(--bg-surface)] border border-[var(--primary)] text-white text-xs sm:text-sm font-bold focus:outline-none w-full sm:w-56"
                    />
                    <span className="absolute right-2 top-2.5 text-[10px] font-mono text-[var(--text-muted)]">
                      {customNameInput.length}/32
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="submit"
                      disabled={!customNameInput.trim()}
                      className="h-9 px-3 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white text-xs font-bold flex items-center gap-1 transition-all disabled:opacity-40"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Save</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingName(false);
                        setCustomNameInput(displayName);
                      }}
                      className="h-9 px-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:border-white/20 text-neutral-300 text-xs font-semibold"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <div className="flex items-center justify-center sm:justify-start gap-2">
                    <h2 className="text-lg font-bold text-white truncate max-w-[200px] sm:max-w-xs">{displayName}</h2>
                    <button
                      type="button"
                      onClick={() => {
                        sound.playClick();
                        setCustomNameInput(displayName);
                        setIsEditingName(true);
                      }}
                      title="Edit Username"
                      className="p-1.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-[var(--text-muted)] hover:text-white transition-all active:scale-95"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {isAdmin && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 w-fit mx-auto sm:mx-0">
                      <ShieldCheck className="w-3 h-3" />
                      <span>Authorized Admin</span>
                    </span>
                  )}
                </div>
              )}

              {nameSuccessToast && (
                <p className="text-xs text-emerald-400 font-semibold flex items-center justify-center sm:justify-start gap-1 mt-1">
                  <Check className="w-3.5 h-3.5" />
                  <span>{nameSuccessToast}</span>
                </p>
              )}

              <p className="text-xs text-[var(--text-muted)] mt-1">
                {isAdmin ? "AI Verified Super Admin · Full Authority" : "Standard Anime Viewer"}
              </p>

              {/* Permanent User ID & Cloud Sync Badge */}
              <div className="mt-2.5 flex flex-wrap items-center justify-center sm:justify-start gap-2">
                <span
                  title={`Permanent User ID: ${userId}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[10px] font-mono text-[var(--text-muted)]"
                >
                  <Fingerprint className="w-3 h-3 text-[var(--primary)]" />
                  <span>UID: {userId.length > 18 ? `${userId.slice(0, 10)}…${userId.slice(-6)}` : userId}</span>
                </span>
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold border ${
                    isProfileSyncedToCloud
                      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                      : "bg-sky-500/15 text-sky-400 border-sky-500/30"
                  }`}
                >
                  <Cloud className="w-3 h-3" />
                  <span>{isProfileSyncedToCloud ? "Cloud Firestore Synced" : "Persistent Profile"}</span>
                </span>
              </div>

              {authMsg && (
                <p className="text-[11px] text-[var(--primary)] mt-1.5 font-medium">{authMsg}</p>
              )}

              <div className="pt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 w-full">
                <button
                  type="button"
                  onClick={() => {
                    sound.playClick();
                    setCustomNameInput(displayName);
                    setIsEditingName(true);
                  }}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-xs font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95"
                >
                  <Edit2 className="w-3.5 h-3.5 text-[var(--primary)] shrink-0" />
                  <span>Change Username</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSection("profile")}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:border-white/20 text-xs font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95"
                >
                  <User className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span>Avatar & Identity</span>
                </button>
                <button
                  type="button"
                  disabled={authBusy}
                  onClick={handleGoogleAccountToggle}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-xs font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                >
                  {authUser ? (
                    <>
                      <LogOut className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>Sign Out Account</span>
                    </>
                  ) : (
                    <>
                      <LogIn className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>Sync Google Account</span>
                    </>
                  )}
                </button>
                {profilePicture && (
                  <button
                    type="button"
                    onClick={handleRemovePhoto}
                    className="min-h-[42px] px-3.5 py-2 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20 text-xs font-bold hover:bg-rose-500/20 flex items-center justify-center gap-2 transition-all active:scale-95"
                  >
                    <Trash2 className="w-3.5 h-3.5 shrink-0" />
                    <span>Reset Picture</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Admin Access Entry Point Card (Visible to Admin Owner or Signed-Out Guests Only) */}
          {(isAdmin || !authUser) && (
            <div className="p-5 rounded-3xl bg-[var(--bg-card)] border border-[var(--border-subtle)] flex flex-col sm:flex-row items-center justify-between gap-4 shadow-sm text-center sm:text-left">
              <div className="flex flex-col sm:flex-row items-center gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
                  <Shield className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    {isAdmin ? "Admin Catalog Dashboard" : "Owner Admin Sign-In"}
                  </h3>
                  <p className="text-xs text-[var(--text-muted)]">
                    {isAdmin
                      ? "Add anime, upload videos, AniList auto-lookup & control catalog"
                      : "Verified Owner Google Account automatically unlocks Admin tools"}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => navigateTo(isAdmin ? "admin" : "admin-login")}
                className="theme-btn-primary w-full sm:w-auto min-h-[44px] px-6 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 active:scale-95 transition-transform shrink-0"
              >
                <span>{isAdmin ? "Open Dashboard" : "Owner Google Sign-In"}</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Quick Settings Group */}
          <div className="rounded-3xl bg-[var(--bg-card)] border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden shadow-sm">
            {/* Theme Engine Selector */}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                sound.playClick();
                setActiveSection("theme");
              }}
              className="w-full text-left p-4 sm:p-5 flex items-center justify-between gap-4 cursor-pointer hover:bg-[var(--bg-surface)]/50 transition-colors"
            >
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--primary)]">
                  <Palette className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white">Theme Engine & Dark/Light Mode</h4>
                  <p className="text-xs text-[var(--text-muted)] capitalize">
                    Mode: {themeMode === "system" ? `System (${resolvedMode})` : themeMode} · Palette: {theme === "emerald" ? "Midnight Emerald" : theme === "graphite" ? "Graphite Blaze" : theme === "astral" ? "Astral Twilight" : "Obsidian Sapphire"}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            </button>

            {/* Audio Engine */}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                sound.playClick();
                setActiveSection("audio");
              }}
              className="w-full text-left p-4 sm:p-5 flex items-center justify-between gap-4 cursor-pointer hover:bg-[var(--bg-surface)]/50 transition-colors"
            >
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-center text-emerald-400">
                  <Volume2 className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white">UI Sound Effects</h4>
                  <p className="text-xs text-[var(--text-muted)] capitalize">
                    {soundEnabled ? `Active · ${soundPack} pack` : "Muted"}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            </button>

            {/* Content Safety Safe Mode */}
            <div className="p-4 sm:p-5 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-center text-violet-400">
                  {safeMode ? <ShieldCheck className="w-5 h-5 text-emerald-400" /> : <ShieldAlert className="w-5 h-5 text-amber-400" />}
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white">Content Safety & Age Filter</h4>
                  <p className="text-xs text-[var(--text-muted)]">
                    {safeMode ? "Restricting 16+, 18+ & mature content" : "Showing all ratings"}
                  </p>
                </div>
              </div>

              {/* Toggle switch */}
              <button
                type="button"
                onClick={() => setSafeMode(!safeMode)}
                aria-label="Toggle safe mode"
                className={`w-12 h-6 rounded-full transition-colors relative flex items-center px-1 ${
                  safeMode ? "bg-[var(--primary)]" : "bg-neutral-800"
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform ${
                    safeMode ? "translate-x-6" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {/* Universal High-Speed Online Engine */}
            <div className="p-4 sm:p-5 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-center text-sky-400">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white">Universal Online Streaming Engine</h4>
                  <p className="text-xs text-[var(--text-muted)]">
                    Smooth touch gestures · Notch safe · Anti-Bug Active
                  </p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-sky-500/15 text-sky-400 border border-sky-500/30">
                Online High-Speed
              </span>
            </div>
          </div>

          {/* Telegram Join Channel Card */}
          <div className="p-6 rounded-3xl bg-gradient-to-b sm:bg-gradient-to-r from-sky-950/60 via-[var(--bg-card)] to-sky-950/40 border border-sky-500/30 shadow-xl relative overflow-hidden">
            {/* Ambient subtle glow */}
            <div className="absolute -top-12 -right-12 w-36 h-36 bg-sky-500/15 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-12 -left-12 w-36 h-36 bg-sky-600/10 rounded-full blur-3xl pointer-events-none" />

            <div className="relative flex flex-col sm:flex-row items-center justify-between gap-5 text-center sm:text-left">
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-sky-500/20 border border-sky-400/40 flex items-center justify-center text-sky-400 shadow-md shadow-sky-950/50 shrink-0">
                  <Send className="w-7 h-7 -translate-x-0.5 translate-y-0.5" />
                </div>
                <div>
                  <div className="flex items-center justify-center sm:justify-start gap-2">
                    <h3 className="text-base font-bold text-white">Official Telegram Community</h3>
                    <span className="px-2 py-0.5 text-[10px] font-extrabold uppercase rounded-full bg-sky-500/20 text-sky-300 border border-sky-400/30">
                      Live
                    </span>
                  </div>
                  <p className="text-xs text-sky-200/90 mt-1 max-w-md">
                    Join our official hub for immediate episode alerts, anime drop notifications, streaming requests, and discussions.
                  </p>
                  <p className="text-[11px] font-mono text-[var(--text-muted)] mt-1">
                    Channel: @ygflashanime · https://t.me/ygflashanime
                  </p>
                </div>
              </div>

              <div className="w-full sm:w-auto flex justify-center shrink-0">
                <a
                  href="https://t.me/ygflashanime"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => sound.playClick()}
                  className="w-full sm:w-auto min-h-[46px] px-6 py-2.5 rounded-2xl bg-sky-500 hover:bg-sky-400 text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2.5 shadow-lg shadow-sky-500/25 active:scale-95 transition-all"
                >
                  <Send className="w-4 h-4" />
                  <span>Join Telegram Channel</span>
                  <ExternalLink className="w-3.5 h-3.5 opacity-80" />
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Theme Section */}
      {activeSection === "theme" && (
        <div className="space-y-6">
          {/* Persistent Appearance Mode (Dark / Light / System Default) */}
          <div className="p-5 rounded-3xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-white">Appearance Mode</h3>
                <p className="text-xs text-[var(--text-muted)]">
                  Saved permanently across reloads, restarts, and login/logout ({resolvedMode === "light" ? "Light active" : "Dark active"})
                </p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              {(
                [
                  { id: "dark", label: "Dark Mode", icon: Moon },
                  { id: "light", label: "Light Mode", icon: Sun },
                  { id: "system", label: "System Default", icon: Monitor },
                ] as { id: ThemeMode; label: string; icon: React.ComponentType<any> }[]
              ).map((opt) => {
                const Icon = opt.icon;
                const active = themeMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={active}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setThemeMode(opt.id);
                    }}
                    className={`min-h-[48px] px-3 py-2.5 rounded-2xl border-2 text-xs font-bold flex flex-col sm:flex-row items-center justify-center gap-2 transition-all active:scale-95 ${
                      active
                        ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)] shadow-sm"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-white"
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {themeSyncError && (
            <div
              role="alert"
              className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex items-start justify-between gap-3"
            >
              <span>{themeSyncError}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  clearThemeSyncError();
                }}
                aria-label="Dismiss theme sync error"
                className="p-1 rounded-lg hover:bg-white/10 text-amber-300 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <p className="text-xs text-[var(--text-muted)]">
            Choose your signature anime streaming palette. Changes take effect immediately across every screen without resetting on refresh.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Midnight Emerald */}
            <button
              type="button"
              aria-pressed={theme === "emerald"}
              data-theme-option="emerald"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTheme("emerald");
              }}
              className={`w-full text-left p-4 rounded-2xl border-2 cursor-pointer transition-colors ${
                theme === "emerald"
                  ? "border-emerald-500 bg-emerald-950/25 shadow-lg shadow-emerald-950/30"
                  : "border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-emerald-500/40"
              }`}
            >
              <div className="h-24 rounded-xl bg-[#070b0d] p-3 flex flex-col justify-between border border-[#1f2e33] mb-3">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-bold text-slate-100">YG FLASH</span>
                  <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-teal-400" />
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="h-2 w-16 bg-emerald-500 rounded" />
                  <div className="h-1 w-10 bg-cyan-400/70 rounded" />
                </div>
              </div>
              <h4 className="text-sm font-bold text-white">Midnight Emerald</h4>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">Midnight Charcoal · Emerald & Teal</p>
            </button>

            {/* Graphite Blaze */}
            <button
              type="button"
              aria-pressed={theme === "graphite"}
              data-theme-option="graphite"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTheme("graphite");
              }}
              className={`w-full text-left p-4 rounded-2xl border-2 cursor-pointer transition-colors ${
                theme === "graphite"
                  ? "border-orange-500 bg-orange-950/20 shadow-lg shadow-orange-950/30"
                  : "border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-neutral-500"
              }`}
            >
              <div className="h-24 rounded-xl bg-[#0c0d10] p-3 flex flex-col justify-between border border-orange-900/30 mb-3">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-bold text-white">YG FLASH</span>
                  <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
                </div>
                <div className="h-2 w-16 bg-orange-500 rounded" />
              </div>
              <h4 className="text-sm font-bold text-white">Graphite Blaze</h4>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">Graphite & Orange</p>
            </button>

            {/* Astral Twilight */}
            <button
              type="button"
              aria-pressed={theme === "astral"}
              data-theme-option="astral"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTheme("astral");
              }}
              className={`w-full text-left p-4 rounded-2xl border-2 cursor-pointer transition-colors ${
                theme === "astral"
                  ? "border-purple-500 bg-purple-950/20 shadow-lg shadow-purple-950/30"
                  : "border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-neutral-500"
              }`}
            >
              <div className="h-24 rounded-xl bg-[#060913] p-3 flex flex-col justify-between border border-purple-900/30 mb-3">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-bold text-white">YG FLASH</span>
                  <span className="w-2.5 h-2.5 rounded-full bg-purple-500" />
                </div>
                <div className="h-2 w-16 bg-purple-500 rounded" />
              </div>
              <h4 className="text-sm font-bold text-white">Astral Twilight</h4>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">Deep Navy & Purple</p>
            </button>

            {/* Obsidian Sapphire (Pure OLED & Electric Blue) */}
            <button
              type="button"
              aria-pressed={theme === "ios"}
              data-theme-option="ios"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTheme("ios");
              }}
              className={`w-full text-left p-4 rounded-2xl border-2 cursor-pointer transition-colors ${
                theme === "ios"
                  ? "border-[#0A84FF] bg-blue-950/30 shadow-lg shadow-blue-900/40"
                  : "border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-neutral-500"
              }`}
            >
              <div className="h-24 rounded-xl bg-[#000000] p-3 flex flex-col justify-between border border-blue-500/30 mb-3 shadow-inner">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-bold text-white">YG FLASH</span>
                  <span className="w-2.5 h-2.5 rounded-full bg-[#0A84FF] shadow-[0_0_8px_#0A84FF]" />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="h-4 rounded-md bg-[#1C1C1E] border border-white/10 flex items-center px-1.5">
                    <div className="w-2 h-2 rounded-full bg-[#0A84FF]" />
                  </div>
                  <div className="h-4 rounded-md bg-[#2C2C2E] border border-white/10 flex items-center justify-end px-1.5">
                    <div className="w-3.5 h-1.5 rounded-full bg-[#30D158]" />
                  </div>
                </div>
              </div>
              <h4 className="text-sm font-bold text-white">Obsidian Sapphire</h4>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">Pure OLED & Electric Blue</p>
            </button>
          </div>
        </div>
      )}

      {/* Audio Engine Section */}
      {activeSection === "audio" && (
        <div className="space-y-5">
          <div className="p-5 rounded-3xl bg-[var(--bg-card)] border border-[var(--border-subtle)] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-white">Master UI Sound</h3>
              <p className="text-xs text-[var(--text-muted)]">
                Synthesized tactile audio feedback for clicks, transitions, and alerts
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setSoundEnabled(!soundEnabled);
                sound.playClick();
              }}
              className={`w-12 h-6 rounded-full transition-colors relative flex items-center px-1 ${
                soundEnabled ? "bg-[var(--primary)]" : "bg-neutral-800"
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full bg-white transition-transform ${
                  soundEnabled ? "translate-x-6" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
              Sound Packs
            </h4>

            {[
              { id: "cyber", title: "Cyber", desc: "Futuristic frequency sweep and synthetic blip" },
              { id: "retro", title: "Retro", desc: "8-bit chiptune arcade bleeps" },
              { id: "soft", title: "Soft Anime", desc: "Gentle marimba chime and warm click" },
            ].map((p) => (
              <div
                key={p.id}
                onClick={() => setSoundPack(p.id as SoundPack)}
                className={`p-4 rounded-2xl border-2 cursor-pointer flex items-center justify-between gap-4 transition-all ${
                  soundPack === p.id
                    ? "border-[var(--primary)] bg-[var(--bg-surface)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-card)]"
                }`}
              >
                <div>
                  <h5 className="text-sm font-bold text-white">{p.title}</h5>
                  <p className="text-xs text-[var(--text-muted)]">{p.desc}</p>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSoundPack(p.id as SoundPack);
                    sound.playSuccess();
                  }}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold text-white"
                >
                  Preview
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Profile Avatar Section */}
      {activeSection === "profile" && (
        <div className="p-6 rounded-3xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-6">
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-28 h-28 rounded-3xl overflow-hidden border-2 border-[var(--border-subtle)] shadow-xl bg-[var(--bg-surface)]">
              {profilePicture ? (
                <img
                  src={profilePicture}
                  alt={displayName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <img
                  src={BRAND_LOGO_IMAGE}
                  alt="Default Mascot"
                  className="w-full h-full object-cover"
                />
              )}
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Custom Profile Picture</h3>
              <p className="text-xs text-[var(--text-muted)] max-w-sm">
                Select any photo from your Android gallery or computer to use as your avatar.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md mx-auto w-full">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="theme-btn-primary min-h-[44px] px-5 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2"
            >
              <Camera className="w-4 h-4" />
              <span>Choose from Gallery</span>
            </button>
            {profilePicture && (
              <button
                type="button"
                onClick={handleRemovePhoto}
                className="min-h-[44px] px-4 py-2.5 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20 text-xs font-bold hover:bg-rose-500/20 flex items-center justify-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                <span>Reset to Default</span>
              </button>
            )}
          </div>

          {/* Custom Username Section */}
          <div className="pt-6 border-t border-[var(--border-subtle)] space-y-4">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-[var(--primary)]" />
              <h4 className="text-sm font-bold text-white">Custom Username</h4>
            </div>

            <form onSubmit={handleSaveUsername} className="space-y-3">
              <div className="relative">
                <input
                  type="text"
                  maxLength={32}
                  value={customNameInput}
                  onChange={(e) => setCustomNameInput(e.target.value)}
                  placeholder="Enter custom username..."
                  className="w-full h-11 px-4 pr-12 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--primary)] text-white text-xs sm:text-sm font-semibold focus:outline-none transition-colors"
                />
                <span className="absolute right-3 top-3 text-[10px] font-mono text-[var(--text-muted)]">
                  {customNameInput.length}/32
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] text-[var(--text-muted)]">Presets:</span>
                  {["ShadowRonin", "FlashOtaku", "CyberSenpai", "KaelZero", "AnimeKing"].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setCustomNameInput(preset);
                        sound.playClick();
                      }}
                      className="px-2 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-[10px] text-[var(--text-muted)] hover:text-white transition-colors"
                    >
                      {preset}
                    </button>
                  ))}
                </div>

                <button
                  type="submit"
                  disabled={!customNameInput.trim()}
                  className="theme-btn-primary px-5 py-2 rounded-xl text-xs font-bold active:scale-95 transition-all disabled:opacity-40"
                >
                  Save Username
                </button>
              </div>

              {nameSuccessToast && (
                <p className="text-xs text-emerald-400 font-semibold flex items-center gap-1 mt-1">
                  <Check className="w-3.5 h-3.5" />
                  <span>{nameSuccessToast}</span>
                </p>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
