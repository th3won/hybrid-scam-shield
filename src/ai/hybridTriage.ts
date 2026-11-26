/**
 * Orchestrates one scan: Tier 1 → escalation policy → Tier 2 → merged verdict.
 *
 * This is the only place that knows the order of operations. It is fully
 * dependency-injected (`AiGateway`, clock, policy) so the tests can drive every
 * branch — on-device success, SDK cloud fallback, model-requested escalation,
 * low-confidence escalation, cloud failure, cloud-only mode, demo mode — without
 * Chrome or Firebase.
 */

import { tryParseTriageResult } from "../core/parse";
import { buildTriagePrompt } from "../core/prompts";
import {
  DEFAULT_ESCALATION_POLICY,
  decideEscalation,
  describeRoute,
  mergeTriageResults,
  resolveInitialRoute,
  type EscalationPolicy
} from "../core/router";
import type {
  EscalationRecord,
  EscalationReason,
  HybridTriageReport,
  Route,
  ScanMode,
  TierRun,
  TriageResult
} from "../core/types";
import type { AiGateway, GenerationRequest } from "./gateway";

export const MAX_INPUT_CHARS = 12_000;

export class TriageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageInputError";
  }
}

export interface HybridTriageRequest {
  text: string;
  channel?: string;
  mode?: ScanMode;
  /** The user pressed "Deep cloud check" before the first scan. */
  userRequestedCloud?: boolean;
}

export interface HybridTriageDeps {
  gateway: AiGateway;
  policy?: EscalationPolicy;
  now?: () => number;
  idFactory?: () => string;
}

export async function runHybridTriage(
  request: HybridTriageRequest,
  deps: HybridTriageDeps
): Promise<HybridTriageReport> {
  const text = normaliseText(request.text);
  assertScannable(text);

  const channel = request.channel ?? "unknown";
  const mode: ScanMode = request.mode ?? "AUTO";
  const policy = deps.policy ?? DEFAULT_ESCALATION_POLICY;
  const now = deps.now ?? defaultNow;
  const startedAt = now();
  const prompt = buildTriagePrompt({ text, channel });
  const notes: string[] = [];

  const initial = resolveInitialRoute({
    engine: deps.gateway.engine,
    mode,
    userRequestedCloud: request.userRequestedCloud === true
  });
  notes.push(`Route: ${describeRoute(initial.route)}.`);

  // ── Demo heuristic only ────────────────────────────────────────────────────
  if (initial.route === "MOCK_ONLY") {
    const tier1 = await executeTier(deps.gateway, { prompt, text, tier: "MOCK", mode: initial.callMode }, now);
    notes.push(
      `Tier 1 executed by the local demo heuristic in ${tier1.latencyMs} ms. Firebase is not configured, so no network call was made.`
    );
    return buildReport({
      id: makeId(deps.idFactory),
      text,
      channel,
      route: "MOCK_ONLY",
      tier1,
      tier2: null,
      escalation: null,
      final: tier1.result,
      notes,
      totalLatencyMs: Math.round(now() - startedAt)
    });
  }

  // ── Cloud-only ─────────────────────────────────────────────────────────────
  if (initial.route === "CLOUD_ONLY") {
    const tier2 = await executeTier(deps.gateway, { prompt, text, tier: "CLOUD", mode: "CLOUD_ONLY" }, now);
    notes.push(`Cloud tier answered in ${tier2.latencyMs} ms with ${tier2.model}.`);
    const escalation: EscalationRecord | null = request.userRequestedCloud
      ? {
          reason: "USER_REQUESTED",
          detail: "You asked for a deep cloud check, so the cloud model ran first.",
          automatic: false
        }
      : null;
    return buildReport({
      id: makeId(deps.idFactory),
      text,
      channel,
      route: "CLOUD_ONLY",
      tier1: null,
      tier2,
      escalation,
      final: tier2.result,
      notes,
      totalLatencyMs: Math.round(now() - startedAt)
    });
  }

  // ── Tier 1: on-device (hybrid PREFER_ON_DEVICE, or forced on-device) ───────
  let tier1: TierRun;
  let escalation: EscalationRecord | null = null;

  try {
    tier1 = await executeTier(
      deps.gateway,
      { prompt, text, tier: "ON_DEVICE", mode: initial.callMode },
      now
    );
    notes.push(
      tier1.source === "IN_CLOUD"
        ? `Tier 1 ran in the cloud — Gemini Nano was not available and the SDK fell back (${tier1.latencyMs} ms).`
        : `Tier 1 ran on-device in ${tier1.latencyMs} ms (${tier1.result.riskLevel}, ${formatPercent(
            tier1.result.confidence
          )}).`
    );
  } catch (error) {
    const message = describeError(error);
    if (mode === "ON_DEVICE_ONLY") {
      throw new TriageInputError(
        `On-device-only scan failed (${message}). Switch the strategy to Auto so the cloud tier can take over.`
      );
    }
    notes.push(`Tier 1 failed (${message}); retrying the same prompt in the cloud.`);
    tier1 = await executeTier(deps.gateway, { prompt, text, tier: "CLOUD", mode: "CLOUD_ONLY" }, now);
    escalation = {
      reason: "TIER1_FAILED",
      detail: `Tier 1 could not run (${message}), so the cloud tier answered instead.`,
      automatic: true
    };
    notes.push(`Cloud fallback answered in ${tier1.latencyMs} ms with ${tier1.model}.`);
  }

  // ── Escalation policy (never in on-device-only mode) ──────────────────────
  let tier2: TierRun | null = null;

  if (mode === "ON_DEVICE_ONLY") {
    notes.push("On-device-only mode: no cloud escalation is allowed for this scan.");
  } else if (tier1.source === "IN_CLOUD" || escalation) {
    notes.push("Tier 2 skipped: the cloud model already produced this verdict.");
  } else {
    const decision = decideEscalation(tier1.result, tier1.source, policy);
    if (!decision.escalate || !decision.reason) {
      notes.push(decision.detail);
    } else {
      escalation = { reason: decision.reason, detail: decision.detail, automatic: true };
      notes.push(`Escalating to the cloud: ${decision.detail}`);
      try {
        tier2 = await executeTier(deps.gateway, { prompt, text, tier: "CLOUD", mode: "CLOUD_ONLY" }, now);
        notes.push(`Tier 2 answered in ${tier2.latencyMs} ms with ${tier2.model}.`);
      } catch (error) {
        notes.push(
          `Cloud escalation failed (${describeError(error)}). Showing the on-device verdict only.`
        );
      }
    }
  }

  const final = tier2 ? mergeTriageResults(tier1.result, tier2.result) : tier1.result;
  const route: Route = tier2
    ? "ON_DEVICE_THEN_CLOUD"
    : tier1.source === "IN_CLOUD"
      ? "CLOUD_ONLY"
      : "ON_DEVICE_ONLY";

  return buildReport({
    id: makeId(deps.idFactory),
    text,
    channel,
    route,
    tier1,
    tier2,
    escalation,
    final,
    notes,
    totalLatencyMs: Math.round(now() - startedAt)
  });
}

/**
 * "Deep cloud check" on an existing report: run Tier 2 again even if the policy
 * already decided it was unnecessary, and merge with the on-device verdict.
 */
export async function escalateReportToCloud(
  report: HybridTriageReport,
  deps: HybridTriageDeps,
  reason: EscalationReason = "USER_REQUESTED"
): Promise<HybridTriageReport> {
  if (!report.tier1) {
    throw new TriageInputError("This scan has no on-device verdict to escalate.");
  }
  if (deps.gateway.engine === "mock") {
    throw new TriageInputError(
      "The cloud tier needs Firebase AI Logic. Add your Firebase config to .env to use it."
    );
  }

  const now = deps.now ?? defaultNow;
  const startedAt = now();
  const prompt = buildTriagePrompt({ text: report.text, channel: report.channel });
  const tier2 = await executeTier(
    deps.gateway,
    { prompt, text: report.text, tier: "CLOUD", mode: "CLOUD_ONLY" },
    now
  );

  const escalation: EscalationRecord = {
    reason,
    detail:
      reason === "USER_REQUESTED"
        ? "You asked for a deep cloud check on this message."
        : "The cloud tier was run again for a deeper look.",
    automatic: reason !== "USER_REQUESTED"
  };

  return buildReport({
    id: report.id,
    text: report.text,
    channel: report.channel,
    route: "ON_DEVICE_THEN_CLOUD",
    tier1: report.tier1,
    tier2,
    escalation,
    final: mergeTriageResults(report.tier1.result, tier2.result),
    notes: [
      ...report.notes,
      `Manual deep cloud check: ${tier2.model} answered in ${tier2.latencyMs} ms.`
    ],
    totalLatencyMs: report.totalLatencyMs + Math.round(now() - startedAt)
  });
}

async function executeTier(
  gateway: AiGateway,
  request: GenerationRequest,
  now: () => number
): Promise<TierRun> {
  const startedAt = now();
  const output = await gateway.generate(request);
  const latencyMs = Math.max(0, Math.round(now() - startedAt));
  const parsed = tryParseTriageResult(output.text);
  if (!parsed.ok) {
    throw new TriageInputError(
      `The model response could not be read as a verdict: ${parsed.error.message}`
    );
  }
  return {
    tier: request.tier,
    source: output.source,
    model: output.model,
    result: parsed.value,
    latencyMs,
    rawText: output.text
  };
}

function buildReport(input: {
  id: string;
  text: string;
  channel: string;
  route: Route;
  tier1: TierRun | null;
  tier2: TierRun | null;
  escalation: EscalationRecord | null;
  final: TriageResult;
  notes: string[];
  totalLatencyMs: number;
}): HybridTriageReport {
  return {
    id: input.id,
    createdAt: new Date().toISOString(),
    text: input.text,
    channel: input.channel,
    route: input.route,
    tier1: input.tier1,
    tier2: input.tier2,
    escalation: input.escalation,
    final: input.final,
    totalLatencyMs: input.totalLatencyMs,
    notes: input.notes
  };
}

function normaliseText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function assertScannable(text: string): void {
  if (text.length === 0) {
    throw new TriageInputError("Paste a message, SMS, email body, or link to analyse.");
  }
  if (text.length < 8) {
    throw new TriageInputError(
      "That is too short to judge. Paste the whole message, including the sender and any link."
    );
  }
  if (text.length > MAX_INPUT_CHARS) {
    throw new TriageInputError(
      `That message is ${text.length.toLocaleString()} characters. The limit is ${MAX_INPUT_CHARS.toLocaleString()}.`
    );
  }
}

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function makeId(factory?: () => string): string {
  if (factory) return factory();
  const cryptoScope = globalThis.crypto;
  if (cryptoScope && typeof cryptoScope.randomUUID === "function") {
    return cryptoScope.randomUUID();
  }
  return `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
