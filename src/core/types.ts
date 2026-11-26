/**
 * Domain types shared by the web demo, the Chrome extension, and the test suite.
 *
 * Everything in this file is dependency-free so that the routing rules can be
 * unit-tested without a browser, a Chrome extension, or a network connection.
 */

export const RISK_LEVELS = ["SAFE", "SUSPICIOUS", "DANGEROUS"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Ordered severity, used when merging tier-1 (on-device) and tier-2 (cloud) verdicts. */
export const RISK_SEVERITY: Record<RiskLevel, number> = {
  SAFE: 0,
  SUSPICIOUS: 1,
  DANGEROUS: 2
};

/**
 * Where the inference that produced a verdict actually ran.
 *
 * `ON_DEVICE` / `IN_CLOUD` come straight from `result.response.inferenceSource`
 * of Firebase AI Logic. `MOCK` is the local demo heuristic that runs when the
 * project has no Firebase configuration yet. `UNKNOWN` means the SDK did not
 * report a source for this call — the UI shows it honestly instead of guessing.
 */
export type InferenceSource = "ON_DEVICE" | "IN_CLOUD" | "MOCK" | "UNKNOWN";

export type Tier = "ON_DEVICE" | "CLOUD" | "MOCK";

/** Structured verdict the models are asked to return. */
export interface TriageResult {
  riskLevel: RiskLevel;
  /** 0.0 – 1.0 */
  confidence: number;
  /** Short evidence phrases quoting the cue that triggered the score. */
  signals: string[];
  /** One or two sentences, in the language of the analysed message. */
  summary: string;
  /** Set by the model when it wants a deeper cloud pass. */
  needsCloudEscalation: boolean;
  /** Concrete next steps — normally only produced by the cloud tier. */
  recommendedActions?: string[];
}

/** One executed inference step. */
export interface TierRun {
  tier: Tier;
  source: InferenceSource;
  model: string;
  result: TriageResult;
  latencyMs: number;
  /** Raw model text, kept for transparency ("show me what the model said"). */
  rawText: string;
}

export type EscalationReason =
  | "MODEL_REQUESTED"
  | "RISK_LEVEL_HIGH"
  | "CONFIDENCE_BELOW_FLOOR"
  | "ON_DEVICE_UNAVAILABLE"
  | "TIER1_FAILED"
  | "USER_REQUESTED";

/** Which tiers a given scan is expected to touch. */
export type Route = "ON_DEVICE_ONLY" | "ON_DEVICE_THEN_CLOUD" | "CLOUD_ONLY" | "MOCK_ONLY";

/** User-facing scan strategy. */
export type ScanMode = "AUTO" | "ON_DEVICE_ONLY" | "CLOUD_ONLY";

/** The inference mode actually handed to the gateway. */
export type GatewayCallMode = "PREFER_ON_DEVICE" | "ON_DEVICE_ONLY" | "CLOUD_ONLY";

export interface EscalationRecord {
  reason: EscalationReason;
  detail: string;
  /** True when a policy rule (not the user) asked for the escalation. */
  automatic: boolean;
}

export interface HybridTriageReport {
  id: string;
  createdAt: string;
  /** Text that was analysed (already trimmed). */
  text: string;
  channel: string;
  route: Route;
  tier1: TierRun | null;
  tier2: TierRun | null;
  escalation: EscalationRecord | null;
  final: TriageResult;
  totalLatencyMs: number;
  /** Human-readable pipeline trace, shown in the UI and copied with the JSON. */
  notes: string[];
}

export function severityOf(level: RiskLevel): number {
  return RISK_SEVERITY[level];
}

/** Higher of two risk levels (ties keep the first). */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return severityOf(b) > severityOf(a) ? b : a;
}
