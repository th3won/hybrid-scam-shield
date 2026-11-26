/// <reference types="vite/client" />

/**
 * Build-time environment. Every value is optional: with none of them the app
 * runs the demo heuristic and says so, instead of failing.
 */
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID?: string;
  readonly VITE_FIREBASE_APP_CHECK_SITE_KEY?: string;
  readonly VITE_FIREBASE_APP_CHECK_DEBUG?: string;
  readonly VITE_AI_CLOUD_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Set by the Firebase App Check SDK in debug mode (must be read before init). */
interface Window {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
}
