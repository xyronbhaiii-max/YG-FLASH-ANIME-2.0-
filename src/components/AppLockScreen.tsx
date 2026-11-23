import React, { useState } from "react";
import { motion } from "motion/react";
import { Lock, Delete, ShieldAlert } from "lucide-react";
import { useApp } from "../context/AppContext";
import { sound } from "../utils/sound";

export const AppLockScreen: React.FC = () => {
  const { verifyPin } = useApp();
  const [enteredPin, setEnteredPin] = useState<string>("");
  const [isError, setIsError] = useState<boolean>(false);

  const handleKeyPress = (digit: string) => {
    sound.playClick();
    if (enteredPin.length < 4) {
      const nextPin = enteredPin + digit;
      setEnteredPin(nextPin);
      setIsError(false);

      if (nextPin.length === 4) {
        setTimeout(() => {
          const success = verifyPin(nextPin);
          if (!success) {
            setIsError(true);
            setEnteredPin("");
          }
        }, 150);
      }
    }
  };

  const handleDelete = () => {
    sound.playClick();
    setEnteredPin((prev) => prev.slice(0, -1));
    setIsError(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between py-12 px-6 bg-[var(--bg-main)] text-white select-none">
      {/* Top Header */}
      <div className="flex flex-col items-center text-center mt-6 space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] flex items-center justify-center shadow-lg">
          <Lock className="w-8 h-8 text-[var(--primary)]" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-bold tracking-tight">YG Flash Protected</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Enter your 4-digit PIN to access YG Flash Anime
          </p>
        </div>

        {/* PIN Dots with Shake Animation on Error */}
        <motion.div
          animate={isError ? { x: [-10, 10, -8, 8, -4, 4, 0] } : {}}
          transition={{ duration: 0.4 }}
          className="flex items-center gap-4 pt-4"
        >
          {[0, 1, 2, 3].map((idx) => {
            const isFilled = idx < enteredPin.length;
            return (
              <div
                key={idx}
                className={`w-4 h-4 rounded-full transition-all duration-200 border ${
                  isFilled
                    ? "bg-[var(--primary)] border-[var(--primary)] scale-110 shadow-[var(--accent-glow)]"
                    : isError
                    ? "border-rose-500 bg-rose-500/20"
                    : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                }`}
              />
            );
          })}
        </motion.div>

        {isError && (
          <p className="text-xs text-rose-500 flex items-center gap-1 font-medium pt-1">
            <ShieldAlert className="w-3.5 h-3.5" />
            Incorrect PIN. Please try again.
          </p>
        )}
      </div>

      {/* Numeric Keypad */}
      <div className="w-full max-w-xs space-y-3 pb-8">
        <div className="grid grid-cols-3 gap-3">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((num) => (
            <button
              key={num}
              type="button"
              onClick={() => handleKeyPress(num)}
              className="h-16 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-xl font-bold font-mono active:scale-95 transition-all flex items-center justify-center text-white"
            >
              {num}
            </button>
          ))}
          <div className="h-16 flex items-center justify-center" />
          <button
            type="button"
            onClick={() => handleKeyPress("0")}
            className="h-16 rounded-2xl bg-[var(--bg-card)] border border-[var(--border-subtle)] hover:border-[var(--primary)] text-xl font-bold font-mono active:scale-95 transition-all flex items-center justify-center text-white"
          >
            0
          </button>
          <button
            type="button"
            onClick={handleDelete}
            aria-label="Delete digit"
            className="h-16 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:border-neutral-500 active:scale-95 transition-all flex items-center justify-center text-neutral-400 hover:text-white"
          >
            <Delete className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  );
};
