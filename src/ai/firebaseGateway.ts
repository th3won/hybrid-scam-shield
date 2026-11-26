/**
 * Real inference through Firebase AI Logic, with hybrid on-device/cloud routing.
 *
 * What this file does
 * -------------------
 *  - initialises `firebase/app`, then App Check (reCAPTCHA Enterprise) when a
 *    site key is configured;
 *  - creates three `GenerativeModel`s, one per inference mode, so a scan can be
 *    forced on-device, forced in-cloud, or hybrid;
 *  - reads `result.response.inferenceSource` for **every** call and reports what
 *    actually happened instead of assuming;
 *  - never hardcodes a key: the config comes from `.env` / build-time env vars.
 *
 * Loaded lazily (`await import("./firebaseGateway")`) so the demo build stays
 * small and works with zero configuration.
 */

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck
} from "firebase/app-check";
import {
  GoogleAIBackend,
  InferenceMode,
  getAI,
  getGenerativeModel,
  type GenerationConfig,
  type GenerativeModel,
  type HybridParams,
  type ModelParams,
  type OnDeviceParams
} from "firebase/ai";

import {
  CLOUD_RESPONSE_SCHEMA,
  ON_DEVICE_RESPONSE_SCHEMA,
  SYSTEM_INSTRUCTION
} from "../core/prompts";
import type {
  AiGateway,
  GatewayCapabilities,
  GenerationOutput,
  GenerationRequest,
  OnDeviceAvailability
} from "./gateway";
import { probeOnDeviceAvailability } from "./onDevice";
import type { FirebaseEnvConfig } from "./config";

export class FirebaseGateway implements AiGateway {
  readonly engine = "firebase" as const;
  readonly label = "Firebase AI Logic";
  readonly cloudModel: string;

  private readonly hybridModel: GenerativeModel;
  private readonly onDeviceModel: GenerativeModel;
  private readonly cloudModelInstance: GenerativeModel;
  private readonly appCheckEnabled: boolean;

  private constructor(params: {
    cloudModel: string;
    hybridModel: GenerativeModel;
    onDeviceModel: GenerativeModel;
    cloudModelInstance: GenerativeModel;
    appCheckEnabled: boolean;
  }) {
    this.cloudModel = params.cloudModel;
    this.hybridModel = params.hybridModel;
    this.onDeviceModel = params.onDeviceModel;
    this.cloudModelInstance = params.cloudModelInstance;
    this.appCheckEnabled = params.appCheckEnabled;
  }

  static create(config: FirebaseEnvConfig): FirebaseGateway {
    const app = ensureApp(config);
    const appCheckEnabled = initAppCheck(app, config);
    const ai = getAI(app, { backend: new GoogleAIBackend() });

    const onDeviceParams = buildOnDeviceParams();
    const cloudParams = buildCloudParams(config.cloudModel);

    const hybridParams: HybridParams = {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams,
      inCloudParams: cloudParams
    };

    const hybridModel = getGenerativeModel(ai, hybridParams);
    const onDeviceModel = getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams
    });
    const cloudModelInstance = getGenerativeModel(ai, cloudParams);

    return new FirebaseGateway({
      cloudModel: config.cloudModel,
      hybridModel,
      onDeviceModel,
      cloudModelInstance,
      appCheckEnabled
    });
  }

  async capabilities(): Promise<GatewayCapabilities> {
    return {
      onDevice: await probeOnDeviceAvailability(),
      appCheck: this.appCheckEnabled,
      cloudModel: this.cloudModel
    };
  }

  /**
   * Trigger the Gemini Nano download/preparation. Explicit user action only —
   * the model is large. Progress is 0..1 when Chrome reports it.
   */
  async prepareOnDevice(onProgress?: (progress: number) => void): Promise<void> {
    await this.hybridModel.initializeDeviceModel((progress) => {
      // Chrome reports 0–100; tolerate 0–1 as well.
      const normalised = Number.isFinite(progress) ? clamp01(progress > 1 ? progress / 100 : progress) : 0;
      onProgress?.(normalised);
    });
  }

  async generate(request: GenerationRequest): Promise<GenerationOutput> {
    const model = this.modelFor(request.mode);
    const response = await model.generateContent(request.prompt);
    const text = response.response.text();
    return {
      text,
      source: mapInferenceSource(response.response.inferenceSource, request.mode),
      model: request.mode === "CLOUD_ONLY" ? this.cloudModel : `${this.cloudModel} (hybrid)`
    };
  }

  private modelFor(mode: GenerationRequest["mode"]): GenerativeModel {
    switch (mode) {
      case "CLOUD_ONLY":
        return this.cloudModelInstance;
      case "ON_DEVICE_ONLY":
        return this.onDeviceModel;
      default:
        return this.hybridModel;
    }
  }
}

/** Create the Firebase AI Logic gateway from build-time environment values. */
export function createFirebaseGateway(config: FirebaseEnvConfig): FirebaseGateway {
  return FirebaseGateway.create(config);
}

function ensureApp(config: FirebaseEnvConfig): FirebaseApp {
  if (getApps().length > 0) return getApp();
  const options: Record<string, string> = {
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    appId: config.appId
  };
  if (config.storageBucket) options.storageBucket = config.storageBucket;
  if (config.messagingSenderId) options.messagingSenderId = config.messagingSenderId;
  if (config.measurementId) options.measurementId = config.measurementId;
  return initializeApp(options);
}

/**
 * App Check.
 *
 * In debug mode `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` must be set *before*
 * `initializeAppCheck`, so the SDK prints a debug token that can be registered in
 * the Firebase console. This is a development switch only.
 */
function initAppCheck(app: FirebaseApp, config: FirebaseEnvConfig): boolean {
  let appCheck: AppCheck | undefined;

  if (config.appCheckDebug) {
    const scope = self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string };
    scope.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }

  if (!config.appCheckSiteKey) return false;

  try {
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(config.appCheckSiteKey),
      isTokenAutoRefreshEnabled: true
    });
    return Boolean(appCheck);
  } catch (error) {
    // Already initialised on this page (hot reload, second gateway) — not fatal.
    console.warn("[scam-shield] App Check initialisation skipped:", error);
    return Boolean((app as unknown as { appCheck?: AppCheck }).appCheck);
  }
}

function buildOnDeviceParams(): OnDeviceParams {
  return {
    createOptions: {
      expectedInputs: [{ type: "text", languages: ["en", "ko"] }],
      expectedOutputs: [{ type: "text", languages: ["en", "ko"] }],
      initialPrompts: [
        {
          role: "system",
          content: [{ type: "text", value: SYSTEM_INSTRUCTION }]
        }
      ]
    },
    promptOptions: {
      // Constrained decoding: the on-device model can only emit this shape.
      responseConstraint: ON_DEVICE_RESPONSE_SCHEMA as unknown as object
    }
  };
}

function buildCloudParams(cloudModel: string): ModelParams {
  const generationConfig: GenerationConfig = {
    responseMimeType: "application/json",
    responseSchema: CLOUD_RESPONSE_SCHEMA as unknown as GenerationConfig["responseSchema"]
  };
  return {
    model: cloudModel,
    systemInstruction: SYSTEM_INSTRUCTION,
    generationConfig
  };
}

/** Map the SDK's inferenceSource (lowercase strings) onto our badge value. */
export function mapInferenceSource(
  source: string | undefined,
  mode: GenerationRequest["mode"]
): GenerationOutput["source"] {
  if (source === "on_device") return "ON_DEVICE";
  if (source === "in_cloud") return "IN_CLOUD";
  // The SDK did not report a source: only claim cloud when we forced cloud.
  return mode === "CLOUD_ONLY" ? "IN_CLOUD" : "UNKNOWN";
}

export function onDeviceLabel(value: OnDeviceAvailability): string {
  return value;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
