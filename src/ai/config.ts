/**
 * Environment / configuration handling.
 *
 * Only public identifiers live here. The Firebase Web API key is a public
 * project identifier (not a secret); real protection comes from App Check and
 * API key restrictions. No service account, Gemini API key or App Check debug
 * token is ever read from or written to this file.
 */

export interface FirebaseEnvConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
  appCheckSiteKey?: string;
  appCheckDebug: boolean;
  cloudModel: string;
}

export interface EnvSnapshot {
  firebase: FirebaseEnvConfig | null;
  missing: string[];
  appCheckDebug: boolean;
  cloudModel: string;
}

export type EnvLike = Record<string, string | boolean | undefined>;

export const DEFAULT_CLOUD_MODEL = "gemini-3.5-flash-lite";

const REQUIRED_KEYS = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID"
] as const;

export function readEnv(env: EnvLike = import.meta.env as unknown as EnvLike): EnvSnapshot {
  const cloudModel = text(env.VITE_AI_CLOUD_MODEL) || DEFAULT_CLOUD_MODEL;
  const appCheckDebug = isTruthy(env.VITE_FIREBASE_APP_CHECK_DEBUG);

  const missing = REQUIRED_KEYS.filter((key) => !text(env[key]));
  const siteKey = text(env.VITE_FIREBASE_APP_CHECK_SITE_KEY);

  if (missing.length > 0) {
    return { firebase: null, missing: [...missing], appCheckDebug, cloudModel };
  }

  const firebase: FirebaseEnvConfig = {
    apiKey: text(env.VITE_FIREBASE_API_KEY),
    authDomain: text(env.VITE_FIREBASE_AUTH_DOMAIN),
    projectId: text(env.VITE_FIREBASE_PROJECT_ID),
    appId: text(env.VITE_FIREBASE_APP_ID),
    appCheckDebug,
    cloudModel
  };

  const storageBucket = text(env.VITE_FIREBASE_STORAGE_BUCKET);
  const messagingSenderId = text(env.VITE_FIREBASE_MESSAGING_SENDER_ID);
  const measurementId = text(env.VITE_FIREBASE_MEASUREMENT_ID);
  if (storageBucket) firebase.storageBucket = storageBucket;
  if (messagingSenderId) firebase.messagingSenderId = messagingSenderId;
  if (measurementId) firebase.measurementId = measurementId;
  if (siteKey) firebase.appCheckSiteKey = siteKey;

  return { firebase, missing: [], appCheckDebug, cloudModel };
}

function text(value: string | boolean | undefined): string {
  if (typeof value === "boolean") return value ? "true" : "";
  return (value ?? "").trim();
}

function isTruthy(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}
