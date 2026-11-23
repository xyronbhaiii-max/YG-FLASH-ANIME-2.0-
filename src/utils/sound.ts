/**
 * Synthesizer Audio Engine using Web Audio API
 * Generates instantaneous, zero-latency UI sound effects for three sound packs:
 * - Cyber: High-tech frequency sweep and resonant blip
 * - Retro: 8-bit square wave arcade sound
 * - Soft: Gentle sine marimba / chime
 *
 * Hardened for Android 5+ to 16+ WebViews and iOS Safari:
 * - Graceful constructor fallback when { latencyHint } is unsupported
 * - Non-Promise ctx.resume() compatibility for older mobile browsers
 * - Strictly try/catch guarded so audio issues NEVER stall or abort button clicks
 */

export type SoundPack = "cyber" | "retro" | "soft";
type SoundKind = "click" | "navigate" | "success" | "error" | "lock";

class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private isEnabled: boolean = true;
  private currentPack: SoundPack = "cyber";
  private lastPlayedAt = new Map<SoundKind, number>();
  private unlockListenersBound = false;
  private hasPlayedSilentUnlock = false;

  constructor() {
    if (typeof window !== "undefined") {
      try {
        const savedEnabled = localStorage.getItem("yg_sound_enabled");
        if (savedEnabled !== null) {
          this.isEnabled = savedEnabled === "true";
        }
        const savedPack = localStorage.getItem("yg_sound_pack") as SoundPack;
        if (savedPack && ["cyber", "retro", "soft"].includes(savedPack)) {
          this.currentPack = savedPack;
        }
      } catch {}
      this.bindGlobalGestureUnlocker();
    }
  }

  private bindGlobalGestureUnlocker() {
    if (this.unlockListenersBound || typeof window === "undefined") return;
    this.unlockListenersBound = true;

    const unlockOnGesture = () => {
      try {
        this.warmUp();
      } catch {}
    };

    try {
      window.addEventListener("pointerdown", unlockOnGesture, { capture: true, passive: true });
      window.addEventListener("touchstart", unlockOnGesture, { capture: true, passive: true });
      window.addEventListener("keydown", unlockOnGesture, { capture: true, passive: true });
    } catch {
      try {
        window.addEventListener("touchstart", unlockOnGesture, true);
        window.addEventListener("keydown", unlockOnGesture, true);
      } catch {}
    }
  }

  private ensureContext(): { ctx: AudioContext; destination: AudioNode } | null {
    if (typeof window === "undefined") return null;
    try {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return null;
        try {
          this.ctx = new AudioCtx({ latencyHint: "interactive" });
        } catch {
          this.ctx = new AudioCtx();
        }
        if (!this.ctx) return null;
        try {
          this.masterGain = this.ctx.createGain();
          this.masterGain.gain.setValueAtTime(1, this.ctx.currentTime);
          this.masterGain.connect(this.ctx.destination);
        } catch {
          this.masterGain = null;
        }
        try {
          this.ctx.onstatechange = () => {
            if (this.ctx?.state !== "running") {
              this.hasPlayedSilentUnlock = false;
            }
          };
        } catch {}
      }

      if (!this.masterGain && this.ctx) {
        try {
          this.masterGain = this.ctx.createGain();
          this.masterGain.gain.setValueAtTime(1, this.ctx.currentTime);
          this.masterGain.connect(this.ctx.destination);
        } catch {
          this.masterGain = null;
        }
      }

      return {
        ctx: this.ctx,
        destination: this.masterGain || this.ctx.destination,
      };
    } catch {
      return null;
    }
  }

  private safeResume(ctx: AudioContext, onResumed?: () => void) {
    try {
      if (typeof ctx.resume !== "function") {
        onResumed?.();
        return;
      }
      const res = ctx.resume() as Promise<void> | undefined;
      if (res && typeof res.then === "function") {
        res
          .then(() => {
            try {
              onResumed?.();
            } catch {}
          })
          .catch(() => {});
      } else {
        onResumed?.();
      }
    } catch {}
  }

  private playSilentUnlockSample(ctx: AudioContext) {
    if (this.hasPlayedSilentUnlock) return;
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
      this.hasPlayedSilentUnlock = true;
    } catch {}
  }

  /**
   * Primes / resumes the Web Audio graph inside a user gesture so subsequent sounds fire instantaneously.
   */
  public warmUp() {
    try {
      const graph = this.ensureContext();
      if (!graph) return;
      const { ctx } = graph;
      if (ctx.state === "suspended" || (ctx.state as string) === "interrupted") {
        this.safeResume(ctx, () => this.playSilentUnlockSample(ctx));
      } else if (ctx.state === "running" && !this.hasPlayedSilentUnlock) {
        this.playSilentUnlockSample(ctx);
      }
    } catch {}
  }

  private shouldThrottle(kind: SoundKind, minGapMs = 30): boolean {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const prev = this.lastPlayedAt.get(kind) ?? -Infinity;
    if (now - prev < minGapMs) return true;
    this.lastPlayedAt.set(kind, now);
    return false;
  }

  private runWhenReady(fn: (ctx: AudioContext, dest: AudioNode) => void) {
    try {
      const graph = this.ensureContext();
      if (!graph) return;
      const { ctx, destination } = graph;

      if (ctx.state === "running") {
        fn(ctx, destination);
        return;
      }

      this.safeResume(ctx, () => {
        this.playSilentUnlockSample(ctx);
        fn(ctx, destination);
      });
    } catch {}
  }

  public setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("yg_sound_enabled", String(enabled));
      } catch {}
    }
    if (enabled) this.warmUp();
  }

  public getEnabled(): boolean {
    return this.isEnabled;
  }

  public setPack(pack: SoundPack) {
    this.currentPack = pack;
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("yg_sound_pack", pack);
      } catch {}
    }
  }

  public getPack(): SoundPack {
    return this.currentPack;
  }

  public playClick() {
    try {
      if (!this.isEnabled || this.shouldThrottle("click", 28)) return;
      const pack = this.currentPack;
      this.runWhenReady((ctx, dest) => {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        if (pack === "cyber") {
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(800, now);
          osc.frequency.exponentialRampToValueAtTime(320, now + 0.06);

          gain.gain.setValueAtTime(0.08, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

          osc.connect(gain);
          gain.connect(dest);
          osc.start(now);
          osc.stop(now + 0.07);
        } else if (pack === "retro") {
          osc.type = "square";
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.setValueAtTime(880, now + 0.03);

          gain.gain.setValueAtTime(0.06, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

          osc.connect(gain);
          gain.connect(dest);
          osc.start(now);
          osc.stop(now + 0.07);
        } else {
          osc.type = "sine";
          osc.frequency.setValueAtTime(659.25, now);
          osc.frequency.exponentialRampToValueAtTime(523.25, now + 0.08);

          gain.gain.setValueAtTime(0.08, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

          osc.connect(gain);
          gain.connect(dest);
          osc.start(now);
          osc.stop(now + 0.09);
        }
      });
    } catch {}
  }

  public playNavigate() {
    try {
      if (!this.isEnabled || this.shouldThrottle("navigate", 45)) return;
      const pack = this.currentPack;
      this.runWhenReady((ctx, dest) => {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        if (pack === "cyber") {
          osc.type = "triangle";
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.exponentialRampToValueAtTime(720, now + 0.08);

          gain.gain.setValueAtTime(0.06, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

          osc.connect(gain);
          gain.connect(dest);
          osc.start(now);
          osc.stop(now + 0.09);
        } else if (pack === "retro") {
          osc.type = "square";
          osc.frequency.setValueAtTime(260, now);
          osc.frequency.setValueAtTime(520, now + 0.04);

          gain.gain.setValueAtTime(0.05, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

          osc.connect(gain);
          gain.connect(dest);
          osc.start(now);
          osc.stop(now + 0.09);
        } else {
          osc.type = "sine";
          osc.frequency.setValueAtTime(523.25, now);
          osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.1);

          gain.gain.setValueAtTime(0.07, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

          osc.connect(gain);
          gain.connect(dest);
          osc.start(now);
          osc.stop(now + 0.11);
        }
      });
    } catch {}
  }

  public playSuccess() {
    try {
      if (!this.isEnabled || this.shouldThrottle("success", 80)) return;
      const pack = this.currentPack;
      this.runWhenReady((ctx, dest) => {
        const notes =
          pack === "retro" ? [440, 554, 659, 880] : [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((freq, idx) => {
          const now = ctx.currentTime + idx * 0.06;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();

          osc.type =
            pack === "retro" ? "square" : pack === "cyber" ? "sawtooth" : "sine";
          osc.frequency.setValueAtTime(freq, now);

          gain.gain.setValueAtTime(0.06, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

          osc.connect(gain);
          gain.connect(dest);
          osc.start(now);
          osc.stop(now + 0.13);
        });
      });
    } catch {}
  }

  public playError() {
    try {
      if (!this.isEnabled || this.shouldThrottle("error", 80)) return;
      this.runWhenReady((ctx, dest) => {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.linearRampToValueAtTime(140, now + 0.15);

        gain.gain.setValueAtTime(0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

        osc.connect(gain);
        gain.connect(dest);
        osc.start(now);
        osc.stop(now + 0.16);
      });
    } catch {}
  }

  public playLock() {
    try {
      if (!this.isEnabled || this.shouldThrottle("lock", 60)) return;
      this.runWhenReady((ctx, dest) => {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.1);

        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

        osc.connect(gain);
        gain.connect(dest);
        osc.start(now);
        osc.stop(now + 0.11);
      });
    } catch {}
  }
}

export const sound = new SoundEngine();
