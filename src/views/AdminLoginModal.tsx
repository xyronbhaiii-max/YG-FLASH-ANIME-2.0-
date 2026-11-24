import React, { useState, useEffect } from "react";
import { ArrowLeft, Shield, AlertCircle, CheckCircle2, LogIn, LogOut, Home } from "lucide-react";
import { useApp } from "../context/AppContext";
import { AUTHORIZED_ADMIN_EMAIL } from "../lib/firebase";
import { sound } from "../utils/sound";
import { BRAND_LOGO_IMAGE } from "../assets/brandAssetsData";

export const AdminLoginModal: React.FC = () => {
  const {
    goBack,
    navigateTo,
    authReady,
    authUser,
    isAdmin,
    signInWithGoogle,
    signOutUser,
  } = useApp();

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Automatically grant Admin Dashboard entry as soon as verified owner signs in
  useEffect(() => {
    if (authReady && isAdmin) {
      navigateTo("admin");
    }
  }, [authReady, isAdmin, navigateTo]);

  const handleOwnerGoogleSignIn = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    sound.playClick();
    try {
      await signInWithGoogle();
    } catch (err: any) {
      const code = err?.code || "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        setErrorMessage("Google sign-in was canceled. Tap Continue with Google when ready.");
      } else if (code === "auth/network-request-failed") {
        setErrorMessage("Network error verifying Google account. Check your connection and try again.");
      } else if (code === "auth/popup-blocked") {
        setErrorMessage("Browser blocked the popup. Allow popups or wait for redirect sign-in.");
      } else {
        setErrorMessage(err?.message || "Could not verify Google account.");
      }
      sound.playError();
    } finally {
      setIsLoading(false);
    }
  };

  const handleSwitchAccount = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await signOutUser();
    } finally {
      setIsLoading(false);
    }
  };

  const isNonAdminSignedIn = Boolean(authReady && authUser && !isAdmin);

  return (
    <div className="max-w-md mx-auto px-4 py-8 space-y-6">
      {/* Top Back Navigation */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back"
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-white active:scale-95 transition-colors duration-100"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-[var(--primary)]" />
            <span>Owner Admin Verification</span>
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Single-owner Google Firebase ID Token authorization
          </p>
        </div>
      </div>

      {/* Admin Card */}
      <div className="p-6 rounded-3xl bg-[var(--bg-card)] border border-[var(--border-subtle)] space-y-5 shadow-xl">
        <div className="flex items-center justify-between p-3.5 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 border border-[var(--border-subtle)]">
              <img
                src={BRAND_LOGO_IMAGE}
                alt="YG Logo"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="text-xs">
              <p className="font-bold text-white">YG Flash Security Core</p>
              <p className="text-[11px] text-[var(--text-muted)]">Single Authorized Owner Only</p>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
            <span>Shield ON</span>
          </span>
        </div>

        {errorMessage && (
          <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{errorMessage}</p>
          </div>
        )}

        {isNonAdminSignedIn ? (
          <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 space-y-3">
            <div className="flex items-start gap-2.5 text-rose-200 text-xs">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-bold text-rose-300">Access Denied — Standard Viewer Account</p>
                <p className="leading-relaxed">
                  You are currently signed in as <span className="font-semibold text-white">{authUser?.email || "another account"}</span>. Admin privileges are restricted strictly to the authorized owner ({AUTHORIZED_ADMIN_EMAIL}).
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => navigateTo("home")}
                className="theme-btn-primary h-11 rounded-xl font-bold text-xs flex items-center justify-center gap-2 active:scale-95 transition-colors duration-100"
              >
                <Home className="w-4 h-4" />
                <span>Return to Home</span>
              </button>
              <button
                type="button"
                disabled={isLoading}
                onClick={handleSwitchAccount}
                className="h-11 rounded-xl bg-[var(--bg-surface)] hover:bg-white/10 border border-[var(--border-subtle)] font-bold text-xs text-white flex items-center justify-center gap-2 active:scale-95 transition-colors duration-100 disabled:opacity-50"
              >
                <LogOut className="w-4 h-4 text-amber-400" />
                <span>Sign Out & Switch</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-2xl bg-gradient-to-r from-[var(--primary)]/10 via-[var(--bg-surface)] to-[var(--primary)]/15 border border-[var(--primary)]/30 space-y-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-[var(--primary)]" />
              <span className="text-xs font-bold text-white">Automatic Owner Sign-In</span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
              Sign in with the verified owner Google account. Admin Dashboard opens automatically upon verification; all other Gmail accounts remain standard viewers.
            </p>
            <button
              type="button"
              disabled={isLoading}
              onClick={handleOwnerGoogleSignIn}
              className="theme-btn-primary w-full h-12 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-2 active:scale-95 transition-colors duration-100 shadow-lg disabled:opacity-50"
            >
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-white animate-spin" />
                  <span>Verifying Google Identity...</span>
                </span>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  <span>Sign In with Owner Google Account</span>
                </>
              )}
            </button>
          </div>
        )}

        <div className="pt-2 border-t border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] space-y-1">
          <p className="flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>Firebase Admin SDK Verification · Custom Claim Protected</span>
          </p>
          <p className="text-neutral-400">
            All admin mutations require a live, server-verified Firebase ID token.
          </p>
        </div>
      </div>
    </div>
  );
};
