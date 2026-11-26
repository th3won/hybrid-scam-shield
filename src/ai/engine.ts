/**
 * Chooses which gateway the app runs on.
 *
 * - No Firebase config in `.env` → the demo heuristic, with a visible banner.
 * - Config present → Firebase AI Logic, loaded lazily.
 * - Config present but initialisation throws (bad key, blocked App Check, no
 *   network) → demo heuristic, and the banner says exactly what failed.
 *
 * The app never pretends a heuristic result came from Gemini: the source badge
 * and the banner reflect the gateway that actually ran.
 */

import { MockGateway } from "./mockGateway";
import { readEnv, type EnvSnapshot } from "./config";
import type { AiGateway } from "./gateway";

export interface EngineSelection {
  gateway: AiGateway;
  mode: "firebase" | "mock";
  reason: string;
  env: EnvSnapshot;
}

export async function selectEngine(
  options: { simulateMockLatency?: boolean } = {}
): Promise<EngineSelection> {
  const env = readEnv();
  const mockLatency = options.simulateMockLatency ?? true;

  if (!env.firebase) {
    return {
      gateway: new MockGateway({ simulateLatency: mockLatency }),
      mode: "mock",
      reason: `Firebase is not configured yet (missing ${env.missing.join(
        ", "
      )}). Results come from the built-in demo heuristic — no message leaves this device.`,
      env
    };
  }

  try {
    const { createFirebaseGateway } = await import("./firebaseGateway");
    const gateway = createFirebaseGateway(env.firebase);
    return {
      gateway,
      mode: "firebase",
      reason: `Firebase AI Logic connected · cloud fallback model ${env.cloudModel}.`,
      env
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      gateway: new MockGateway({ simulateLatency: mockLatency }),
      mode: "mock",
      reason: `Firebase AI Logic could not start (${message}). Falling back to the demo heuristic.`,
      env
    };
  }
}
