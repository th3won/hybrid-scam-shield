/** Small, dependency-free formatting helpers shared by every surface. */

import type { InferenceSource, RiskLevel } from "../core/types";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export function percent(value: number): string {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return `${Math.round(clamped * 100)}%`;
}

export function formatMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export type Tone = "safe" | "suspicious" | "danger" | "device" | "cloud" | "mock" | "unknown";

export function riskTone(level: RiskLevel): Tone {
  switch (level) {
    case "SAFE":
      return "safe";
    case "SUSPICIOUS":
      return "suspicious";
    default:
      return "danger";
  }
}

export function riskHeadline(level: RiskLevel): string {
  switch (level) {
    case "SAFE":
      return "Looks safe";
    case "SUSPICIOUS":
      return "Treat with caution";
    default:
      return "Likely a scam";
  }
}

export function riskIcon(level: RiskLevel): string {
  switch (level) {
    case "SAFE":
      return "✅";
    case "SUSPICIOUS":
      return "⚠️";
    default:
      return "🚨";
  }
}

export function sourceTone(source: InferenceSource): Tone {
  switch (source) {
    case "ON_DEVICE":
      return "device";
    case "IN_CLOUD":
      return "cloud";
    case "MOCK":
      return "mock";
    default:
      return "unknown";
  }
}

export function sourceLabel(source: InferenceSource): string {
  switch (source) {
    case "ON_DEVICE":
      return "ON-DEVICE";
    case "IN_CLOUD":
      return "CLOUD";
    case "MOCK":
      return "DEMO MOCK";
    default:
      return "SOURCE ?";
  }
}

export function sourceIcon(source: InferenceSource): string {
  switch (source) {
    case "ON_DEVICE":
      return "🖥️";
    case "IN_CLOUD":
      return "☁️";
    case "MOCK":
      return "🧪";
    default:
      return "❔";
  }
}

/** Human explanation of what the source badge means. */
export function sourceHelp(source: InferenceSource): string {
  switch (source) {
    case "ON_DEVICE":
      return "This verdict was produced by Gemini Nano on this device. The message was not uploaded.";
    case "IN_CLOUD":
      return "This verdict came from the cloud model (Firebase AI Logic).";
    case "MOCK":
      return "Demo heuristic running locally because Firebase is not configured. Not an AI model.";
    default:
      return "The SDK did not report where this inference ran.";
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function downloadText(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
