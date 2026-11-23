import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.ygflash.anime",
  appName: "YG FLASH ANIME",
  webDir: "dist",
  server: {
    androidScheme: "https",
    allowNavigation: [
      "grand-gizmo-3v0ns.firebaseapp.com",
      "accounts.google.com",
      "*.googleapis.com",
      "*.run.app",
      "*.b-cdn.net",
      "*.bunnycdn.com",
      "iframe.mediadelivery.net",
      "*.youtube.com",
      "*.youtube-nocookie.com",
    ],
  },
  android: {
    allowMixedContent: true,
    backgroundColor: "#070b0d",
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: "#070b0d",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#070b0d",
      overlaysWebView: false,
    },
    FirebaseAuthentication: {
      skipNativeAuth: false,
      providers: ["google.com"],
    },
  },
};

export default config;
