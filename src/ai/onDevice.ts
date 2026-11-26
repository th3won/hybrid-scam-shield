/**
 * Reads the on-device language model availability that Chrome exposes globally
 * (`LanguageModel.availability()` in Chrome 138+, `capabilities()` in earlier
 * Origin Trial builds).
 *
 * We probe it read-only: this never starts a model download. Preparing the model
 * is an explicit user action (`gateway.prepareOnDevice()`), because Gemini Nano
 * is a multi-gigabyte download and must not start silently on page load.
 */

import type { OnDeviceAvailability } from "./gateway";

interface LanguageModelGlobal {
  availability?: () => Promise<string>;
  capabilities?: () => Promise<{ available?: string } | undefined>;
}

type GlobalWithLanguageModel = typeof globalThis & { LanguageModel?: LanguageModelGlobal };

export async function probeOnDeviceAvailability(): Promise<OnDeviceAvailability> {
  const scope = globalThis as GlobalWithLanguageModel;
  const languageModel = scope.LanguageModel;
  if (!languageModel) return "unknown";

  try {
    if (typeof languageModel.availability === "function") {
      return mapAvailability(await languageModel.availability());
    }
    if (typeof languageModel.capabilities === "function") {
      const capabilities = await languageModel.capabilities();
      return mapAvailability(capabilities?.available);
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

function mapAvailability(value: string | undefined): OnDeviceAvailability {
  switch ((value ?? "").trim().toLowerCase()) {
    case "available":
    case "readily":
      return "available";
    case "downloadable":
    case "download":
    case "after-download":
      return "downloadable";
    case "downloading":
      return "downloading";
    case "unavailable":
    case "no":
      return "unavailable";
    default:
      return "unknown";
  }
}

export function describeAvailability(value: OnDeviceAvailability): string {
  switch (value) {
    case "available":
      return "Gemini Nano ready";
    case "downloadable":
      return "Gemini Nano available to download";
    case "downloading":
      return "Gemini Nano downloading";
    case "unavailable":
      return "Gemini Nano not usable on this device";
    default:
      return "Gemini Nano status unknown";
  }
}
