/**
 * Tolerant parsing of model output.
 *
 * On-device models (Gemini Nano) and cloud models are asked for strict JSON, and
 * both support a response schema — but in practice a model can still wrap the
 * object in a markdown fence, prepend "Here is the analysis:", use a synonym for
 * the risk level, or return confidence as a percentage. The triage flow must not
 * crash on any of that, so every field is normalised here and every rejection
 * carries a specific reason that the UI can display.
 */

import { RISK_LEVELS, type RiskLevel, type TriageResult } from "./types";

export class TriageParseError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.name = "TriageParseError";
    this.raw = raw;
  }
}

export type ParseOutcome =
  | { ok: true; value: TriageResult; repaired: string[] }
  | { ok: false; error: TriageParseError };

const RISK_ALIASES: Record<string, RiskLevel> = {
  // SAFE
  SAFE: "SAFE",
  CLEAN: "SAFE",
  BENIGN: "SAFE",
  LEGIT: "SAFE",
  LEGITIMATE: "SAFE",
  OK: "SAFE",
  NONE: "SAFE",
  LOW: "SAFE",
  GREEN: "SAFE",
  NOT_SCAM: "SAFE",
  // SUSPICIOUS
  SUSPICIOUS: "SUSPICIOUS",
  SUSPECT: "SUSPICIOUS",
  SUSPECTED: "SUSPICIOUS",
  WARNING: "SUSPICIOUS",
  WARN: "SUSPICIOUS",
  MEDIUM: "SUSPICIOUS",
  MODERATE: "SUSPICIOUS",
  UNKNOWN: "SUSPICIOUS",
  UNSURE: "SUSPICIOUS",
  UNCERTAIN: "SUSPICIOUS",
  POSSIBLY_SCAM: "SUSPICIOUS",
  YELLOW: "SUSPICIOUS",
  // DANGEROUS
  DANGEROUS: "DANGEROUS",
  DANGER: "DANGEROUS",
  HIGH: "DANGEROUS",
  CRITICAL: "DANGEROUS",
  SCAM: "DANGEROUS",
  MALICIOUS: "DANGEROUS",
  PHISHING: "DANGEROUS",
  FRAUD: "DANGEROUS",
  RED: "DANGEROUS"
};

const MAX_SIGNALS = 8;
const MAX_ACTIONS = 8;

/**
 * Pull the first balanced JSON object out of arbitrary text.
 * Handles markdown fences, leading prose, trailing prose, and braces inside strings.
 */
export function extractJsonObject(raw: string): unknown {
  const text = stripBom(raw).trim();
  if (text.length === 0) {
    throw new TriageParseError("The model returned an empty response.", raw);
  }

  const candidates: string[] = [];
  const fenced = extractFencedBlocks(text);
  candidates.push(...fenced);

  const firstBrace = text.indexOf("{");
  if (firstBrace >= 0) {
    const balanced = readBalancedObject(text, firstBrace);
    if (balanced) candidates.push(balanced);
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") {
        return parsed[0];
      }
    } catch {
      /* try the next candidate */
    }
  }

  throw new TriageParseError(
    "Could not find a JSON verdict object in the model response.",
    truncate(raw, 800)
  );
}

/** Parse and normalise a raw model response into a `TriageResult`. */
export function parseTriageResult(raw: string): TriageResult {
  const outcome = tryParseTriageResult(raw);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export function tryParseTriageResult(raw: string): ParseOutcome {
  let json: unknown;
  try {
    json = extractJsonObject(raw);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof TriageParseError
          ? error
          : new TriageParseError(String(error), truncate(raw, 800))
    };
  }

  const repaired: string[] = [];
  const record = asRecord(json);
  if (!record) {
    return { ok: false, error: new TriageParseError("The JSON verdict is not an object.", raw) };
  }

  const rawLevel = pick(record, ["riskLevel", "risk_level", "risk", "verdict", "level"]);
  if (rawLevel === undefined || rawLevel === null) {
    return {
      ok: false,
      error: new TriageParseError("The verdict is missing `riskLevel`.", truncate(raw, 800))
    };
  }
  let riskLevel: RiskLevel;
  try {
    riskLevel = normalizeRiskLevel(rawLevel);
  } catch (error) {
    return {
      ok: false,
      error: new TriageParseError(
        `Unrecognised risk level: ${JSON.stringify(rawLevel)}.`,
        truncate(raw, 800)
      )
    };
  }
  if (String(rawLevel).trim().toUpperCase() !== riskLevel) {
    repaired.push(`riskLevel normalised from ${JSON.stringify(rawLevel)} to ${riskLevel}`);
  }

  const rawConfidence = pick(record, ["confidence", "confidenceScore", "score", "probability"]);
  let confidence = 0.5;
  if (rawConfidence !== undefined && rawConfidence !== null) {
    const normalised = normalizeConfidence(rawConfidence);
    if (normalised === null) {
      repaired.push("confidence was unusable, defaulted to 0.5");
    } else {
      confidence = normalised;
      if (typeof rawConfidence === "string" || normalised > 1) {
        repaired.push(`confidence normalised from ${JSON.stringify(rawConfidence)}`);
      }
      if (Number(rawConfidence) > 1) repaired.push("confidence interpreted as a percentage");
    }
  } else {
    repaired.push("confidence missing, defaulted to 0.5");
  }

  const signals = normalizeStringList(
    pick(record, ["signals", "indicators", "redFlags", "red_flags", "evidence"]),
    MAX_SIGNALS
  );

  const summaryRaw = pick(record, ["summary", "explanation", "reason", "assessment"]);
  let summary = asString(summaryRaw).trim();
  if (summary.length === 0) {
    summary =
      riskLevel === "SAFE"
        ? "No meaningful scam indicators were found."
        : "Suspicious patterns were detected in this message.";
    repaired.push("summary missing, generated a fallback");
  }

  const escalationRaw = pick(record, [
    "needsCloudEscalation",
    "needs_cloud_escalation",
    "escalate",
    "needsEscalation"
  ]);
  let needsCloudEscalation = false;
  if (escalationRaw !== undefined && escalationRaw !== null) {
    const parsed = normalizeBoolean(escalationRaw);
    if (parsed === null) {
      repaired.push("needsCloudEscalation was unusable, defaulted to false");
    } else {
      needsCloudEscalation = parsed;
    }
  } else if (riskLevel === "DANGEROUS") {
    needsCloudEscalation = true;
    repaired.push("needsCloudEscalation missing, defaulted to true for a DANGEROUS verdict");
  }

  const actions = normalizeStringList(
    pick(record, [
      "recommendedActions",
      "recommended_actions",
      "actionChecklist",
      "actions",
      "nextSteps"
    ]),
    MAX_ACTIONS
  );

  const value: TriageResult = {
    riskLevel,
    confidence,
    signals,
    summary,
    needsCloudEscalation
  };
  if (actions.length > 0) value.recommendedActions = actions;

  return { ok: true, value, repaired };
}

/** Normalise a risk level, accepting the synonyms models actually emit. */
export function normalizeRiskLevel(value: unknown): RiskLevel {
  const text = asString(value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (text.length === 0) throw new TriageParseError("Empty risk level.", "");
  const direct = RISK_ALIASES[text];
  if (direct) return direct;
  const withoutSuffix = text.replace(/_(RISK|LEVEL|SCORE)$/, "");
  const alias = RISK_ALIASES[withoutSuffix];
  if (alias) return alias;
  if ((RISK_LEVELS as readonly string[]).includes(text)) return text as RiskLevel;
  throw new TriageParseError(`Unknown risk level: ${JSON.stringify(value)}`, String(value));
}

/** Accept 0–1 floats, 0–100 percentages, and strings like "85%". */
export function normalizeConfidence(value: unknown): number | null {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const isPercent = trimmed.endsWith("%");
    const parsed = Number(trimmed.replace(/%$/, ""));
    if (!Number.isFinite(parsed)) return null;
    numeric = isPercent ? parsed / 100 : parsed;
  } else {
    return null;
  }
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 1 && numeric <= 100) numeric = numeric / 100;
  if (numeric < 0) numeric = 0;
  if (numeric > 1) numeric = 1;
  return Math.round(numeric * 1000) / 1000;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "yes", "y", "1", "required", "escalate"].includes(text)) return true;
    if (["false", "no", "n", "0", "none", "not needed"].includes(text)) return false;
  }
  return null;
}

function normalizeStringList(value: unknown, limit: number): string[] {
  const out: string[] = [];
  const push = (item: unknown) => {
    const text = asString(item).replace(/\s+/g, " ").trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (out.some((existing) => existing.toLowerCase() === key)) return;
    if (out.length < limit) out.push(text);
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        push(pick(record, ["text", "label", "signal", "action", "description", "detail"]));
      } else {
        push(item);
      }
    }
  } else if (typeof value === "string") {
    for (const part of value.split(/\r?\n|;|(?:^|\s)[-•*]\s+/)) push(part);
  }
  return out;
}

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const value = record[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  // Case-insensitive second pass (models sometimes change casing).
  const lookup = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]));
  for (const key of keys) {
    const actual = lookup.get(key.toLowerCase());
    if (actual !== undefined && record[actual] !== undefined && record[actual] !== null) {
      return record[actual];
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join(", ");
  return "";
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

/** Read a balanced `{...}` block, respecting strings and escapes. */
function readBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
