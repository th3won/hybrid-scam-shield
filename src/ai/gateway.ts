/**
 * The single seam between the app and any inference provider.
 *
 * `FirebaseGateway` (real hybrid inference) and `MockGateway` (demo heuristic)
 * both implement this. Everything above — routing, escalation, merging, UI —
 * only knows this interface, which is why the routing logic is testable without
 * a network, a Firebase project, or Chrome.
 */

import type { GatewayCallMode, InferenceSource, Tier } from "../core/types";

export interface GenerationRequest {
  /** Fully built prompt, including the system instruction for the cloud tier. */
  prompt: string;
  /** The raw message under review (the demo engine scores this directly). */
  text: string;
  tier: Tier;
  mode: GatewayCallMode;
}

export interface GenerationOutput {
  /** Raw model text — parsed by `parseTriageResult`, never trusted blindly. */
  text: string;
  /**
   * Where this specific call actually ran. Firebase AI Logic reports it as
   * `result.response.inferenceSource`; `UNKNOWN` is used when the SDK stayed
   * silent rather than guessing.
   */
  source: InferenceSource;
  model: string;
}

export type OnDeviceAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable"
  | "unknown";

export interface GatewayCapabilities {
  onDevice: OnDeviceAvailability;
  appCheck: boolean;
  cloudModel: string;
}

export interface AiGateway {
  readonly engine: "firebase" | "mock";
  readonly label: string;
  readonly cloudModel: string;
  capabilities(): Promise<GatewayCapabilities>;
  /** Ask the browser to download/prepare the on-device model. */
  prepareOnDevice(onProgress?: (progress: number) => void): Promise<void>;
  generate(request: GenerationRequest): Promise<GenerationOutput>;
}
