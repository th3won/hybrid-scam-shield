/**
 * The hybrid routing brain — pure functions, no I/O.
 *
 * This module decides three things and nothing else:
 *
 *   1. Which tier a scan starts in (`resolveInitialRoute`).
 *   2. Whether the on-device verdict is good enough, or the cloud tier must
 *      run too (`decideEscalation`).
 *   3. What the final verdict is when both tiers spoke (`mergeTriageResults`).
 *
 * The privacy-first promise of the product lives here: Tier 1 is preferred on
 * every scan, and a cloud call only happens for a reason we can print on screen.
 */

import {
  RISK_SEVERITY,
  maxRisk,
  severityOf,
  type EscalationReason,
  type GatewayCallMode,
  type InferenceSource,
  type RiskLevel,
  type Route,
  type ScanMode,
  type TriageResult
} from "./types";

export interface EscalationPolicy {
  /**
   * Below this confidence a verdict is treated as "not sure yet" and gets a
   * second, deeper look in the cloud. Applies to every risk level: a
   * low-confidence SAFE is the most dangerous answer of all.
   */
  confidenceFloor: number;
  /** Escalate every DANGEROUS verdict so the user also gets an action checklist. */
  escalateDangerous: boolean;
}

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  confidenceFloor: 0.6,
  escalateDangerous: true
};

export interface EscalationDecision {
  escalate: boolean;
  reason: EscalationReason | null;
  detail: string;
}

export interface InitialRouteInput {
  engine: "firebase" | "mock";
  mode: ScanMode;
  /** The user pressed "Deep Cloud Check" for this scan. */
  userRequestedCloud?: boolean;
}

export interface InitialRoute {
  route: Route;
  callMode: GatewayCallMode;
}

/** Decide where a fresh scan starts. */
export function resolveInitialRoute(input: InitialRouteInput): InitialRoute {
  if (input.engine === "mock") {
    return { route: "MOCK_ONLY", callMode: "PREFER_ON_DEVICE" };
  }
  if (input.mode === "CLOUD_ONLY") {
    return { route: "CLOUD_ONLY", callMode: "CLOUD_ONLY" };
  }
  if (input.mode === "ON_DEVICE_ONLY") {
    return { route: "ON_DEVICE_ONLY", callMode: "ON_DEVICE_ONLY" };
  }
  if (input.userRequestedCloud) {
    return { route: "CLOUD_ONLY", callMode: "CLOUD_ONLY" };
  }
  // AUTO: start on-device. `PREFER_ON_DEVICE` lets the SDK fall back to the cloud
  // model instead of failing when Gemini Nano is not installed yet.
  return { route: "ON_DEVICE_ONLY", callMode: "PREFER_ON_DEVICE" };
}

/**
 * Should we spend a cloud call after Tier 1?
 *
 * Order matters — the first matching rule is the reason shown to the user.
 */
export function decideEscalation(
  tier1: TriageResult,
  tier1Source: InferenceSource,
  policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY
): EscalationDecision {
  if (tier1Source === "IN_CLOUD") {
    return {
      escalate: false,
      reason: null,
      detail:
        "Tier 1 already fell back to the cloud model (Gemini Nano unavailable), so a second remote call would duplicate the same work."
    };
  }

  if (tier1.needsCloudEscalation) {
    return {
      escalate: true,
      reason: "MODEL_REQUESTED",
      detail: "The on-device verdict explicitly asked for deeper cloud analysis."
    };
  }

  if (policy.escalateDangerous && tier1.riskLevel === "DANGEROUS") {
    return {
      escalate: true,
      reason: "RISK_LEVEL_HIGH",
      detail:
        "On-device flagged a DANGEROUS message; a cloud pass adds the concrete action checklist."
    };
  }

  if (tier1.confidence < policy.confidenceFloor) {
    return {
      escalate: true,
      reason: "CONFIDENCE_BELOW_FLOOR",
      detail: `On-device confidence ${formatPercent(tier1.confidence)} is below the ${formatPercent(
        policy.confidenceFloor
      )} floor.`
    };
  }

  return {
    escalate: false,
    reason: null,
    detail: `On-device verdict is confident enough (${formatPercent(
      tier1.confidence
    )}); the cloud tier was skipped to keep the message on this device.`
  };
}

/**
 * Combine the two tiers into one verdict.
 *
 * Rules:
 *  - the higher risk level wins (never let the cloud quietly downgrade an
 *    on-device alarm);
 *  - on a tie the cloud verdict wins, because it saw the same text with more
 *    capacity;
 *  - signals are unioned, cloud first, de-duplicated, capped;
 *  - a completed escalation means no further escalation is needed.
 */
export function mergeTriageResults(tier1: TriageResult, tier2: TriageResult): TriageResult {
  const riskLevel: RiskLevel = maxRisk(tier1.riskLevel, tier2.riskLevel);
  const cloudWins = severityOf(tier2.riskLevel) >= severityOf(tier1.riskLevel);
  const primary = cloudWins ? tier2 : tier1;
  const secondary = cloudWins ? tier1 : tier2;

  const signals: string[] = [];
  for (const signal of [...primary.signals, ...secondary.signals]) {
    const text = signal.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (signals.some((existing) => existing.toLowerCase() === text.toLowerCase())) continue;
    if (signals.length >= 8) break;
    signals.push(text);
  }

  const actions = (tier2.recommendedActions ?? []).length
    ? tier2.recommendedActions
    : tier1.recommendedActions;

  const merged: TriageResult = {
    riskLevel,
    confidence: primary.confidence,
    signals,
    summary: primary.summary,
    needsCloudEscalation: false
  };
  if (actions && actions.length > 0) merged.recommendedActions = [...actions];
  return merged;
}

/** Short, user-facing label for a route. */
export function describeRoute(route: Route): string {
  switch (route) {
    case "MOCK_ONLY":
      return "Demo heuristic (no Firebase config)";
    case "ON_DEVICE_ONLY":
      return "On-device only";
    case "ON_DEVICE_THEN_CLOUD":
      return "On-device → cloud escalation";
    case "CLOUD_ONLY":
      return "Cloud only";
    default:
      return route;
  }
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export { RISK_SEVERITY };
