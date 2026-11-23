import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { sound } from "../utils/sound";
import {
  BLINK_STAR_IMAGE,
  BRAND_LOGO_IMAGE,
  LOADING_REAPER_IMAGE,
} from "../assets/brandAssetsData";

interface IntroScreenProps {
  onComplete: () => void;
}

export const IntroScreen: React.FC<IntroScreenProps> = ({ onComplete }) => {
  const [progress, setProgress] = useState(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const completedRef = useRef(false);

  const finishIntro = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    sound.playSuccess();
    onCompleteRef.current();
  };

  const statusText =
    progress > 85
      ? "Ready to stream"
      : progress > 55
        ? "Preparing your experience..."
        : progress > 25
          ? "Synchronizing anime catalog..."
          : "Initializing core protocols...";

  useEffect(() => {
    sound.playNavigate();

    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          return 100;
        }
        const increment = Math.floor(Math.random() * 14) + 18;
        return Math.min(prev + increment, 100);
      });
    }, 55);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (progress < 100 || completedRef.current) return;
    const timer = setTimeout(() => {
      finishIntro();
    }, 140);
    return () => clearTimeout(timer);
  }, [progress]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.25, ease: "easeOut" } }}
        onClick={finishIntro}
        className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black text-white px-6 select-none cursor-pointer"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            finishIntro();
          }}
          className="absolute top-4 right-4 z-20 min-h-[40px] px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/15 text-xs font-bold text-white/90 active:scale-95 transition-transform"
        >
          Skip
        </button>

        {/* Subtle radial ambient glow behind logo */}
        <div className="absolute w-96 h-96 rounded-full bg-white/5 blur-2xl pointer-events-none" />

        <div className="relative z-10 flex flex-col items-center text-center max-w-sm w-full">
          {/* Logo Container with Smooth Breathing & Scale Animation */}
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="relative w-32 h-32 md:w-36 md:h-36 mb-8 rounded-2xl ring-1 ring-white/10 animate-logo-aura"
          >
            <div className="w-full h-full rounded-2xl overflow-hidden shadow-2xl shadow-black/80">
              <img
                src={BRAND_LOGO_IMAGE}
                alt="YG Flash Anime Logo"
                className="w-full h-full object-cover"
              />
              {/* Subtle cinematic highlight */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-white/10 pointer-events-none" />
            </div>

            {/* Background-Removed Red Star Blinking Animation on Logo Side */}
            <img
              src={BLINK_STAR_IMAGE}
              alt=""
              aria-hidden="true"
              className="absolute -top-3.5 -right-3.5 w-8 h-8 object-contain pointer-events-none select-none animate-star-blink"
            />
          </motion.div>

          {/* Typography */}
          <motion.div
            initial={{ y: 15, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.2, duration: 0.6 }}
            className="space-y-1.5 mb-6"
          >
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-white">
              Welcome to YG Flash Anime
            </h1>
            <p className="text-xs sm:text-sm font-medium text-neutral-400">
              {statusText}
            </p>
          </motion.div>

          {/* User's 1st Image: Reaper Loading Graphic (Deadline text removed via cropping) */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="w-full max-w-sm relative rounded-2xl overflow-hidden bg-black border border-neutral-800/80 p-2 shadow-2xl mb-4 group"
          >
            {/* Cropped viewing window focusing on the reaper & progress bar, hiding the bottom "Deadline..." text */}
            <div className="relative w-full h-20 sm:h-24 overflow-hidden rounded-xl bg-black flex items-center justify-center">
              <img
                src={LOADING_REAPER_IMAGE}
                alt="Loading Animation Graphic"
                className="w-full h-[185%] object-cover object-top -translate-y-2 select-none pointer-events-none"
              />
              {/* Bottom black cover bar to guarantee 100% removal of the 'Deadline...' text */}
              <div className="absolute bottom-0 left-0 right-0 h-4 bg-black pointer-events-none" />
              {/* Subtle emerald/theme ambient wash over the loading graphic */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: "linear-gradient(90deg, rgba(var(--primary-rgb), 0.12), transparent 65%)",
                }}
              />
            </div>
          </motion.div>

          {/* Loading Progress Bar & Percentage */}
          <div className="w-full max-w-xs space-y-2">
            <div className="h-1.5 w-full bg-neutral-900 rounded-full overflow-hidden p-0.5 border border-neutral-800">
              <motion.div
                className="h-full rounded-full"
                style={{
                  background: "linear-gradient(90deg, var(--primary), #14b8a6, #e2e8f0)",
                  boxShadow: "0 0 10px rgba(var(--primary-rgb), 0.45)",
                }}
                initial={{ width: "0%" }}
                animate={{ width: `${progress}%` }}
                transition={{ ease: "easeOut" }}
              />
            </div>
            <div className="flex justify-between items-center text-[11px] font-mono tabular-nums text-neutral-400 pt-1">
              <span className="flex items-center gap-1.5 text-[var(--primary)] font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)] animate-ping" />
                SYSTEM BOOT
              </span>
              <span className="font-bold text-white">{progress}%</span>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
