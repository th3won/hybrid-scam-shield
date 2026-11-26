import { describe, expect, it } from "vitest";

import {
  DEFAULT_ESCALATION_POLICY,
  decideEscalation,
  describeRoute,
  mergeTriageResults,
  resolveInitialRoute
} from "../src/core/router";
import type { TriageResult } from "../src/core/types";

function verdict(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    riskLevel: "SAFE",
    confidence: 0.9,
    signals: ["no urgency cues"],
    summary: "Looks fine.",
    needsCloudEscalation: false,
    ...overrides
  };
}

describe("resolveInitialRoute", () => {
  it("starts on-device in AUTO mode", () => {
    expect(resolveInitialRoute({ engine: "firebase", mode: "AUTO" })).toEqual({
      route: "ON_DEVICE_ONLY",
      callMode: "PREFER_ON_DEVICE"
    });
  });

  it("honours an explicit cloud request before the first call", () => {
    expect(
      resolveInitialRoute({ engine: "firebase", mode: "AUTO", userRequestedCloud: true })
    ).toEqual({ route: "CLOUD_ONLY", callMode: "CLOUD_ONLY" });
  });

  it("respects forced on-device and forced cloud modes", () => {
    expect(resolveInitialRoute({ engine: "firebase", mode: "ON_DEVICE_ONLY" }).callMode).toBe(
      "ON_DEVICE_ONLY"
    );
    expect(resolveInitialRoute({ engine: "firebase", mode: "CLOUD_ONLY" }).route).toBe("CLOUD_ONLY");
  });

  it("never touches the network without Firebase", () => {
    expect(resolveInitialRoute({ engine: "mock", mode: "AUTO" }).route).toBe("MOCK_ONLY");
    expect(resolveInitialRoute({ engine: "mock", mode: "CLOUD_ONLY" }).route).toBe("MOCK_ONLY");
  });
});

describe("decideEscalation", () => {
  it("escalates when the on-device model asks for it", () => {
    const decision = decideEscalation(verdict({ needsCloudEscalation: true }), "ON_DEVICE");
    expect(decision).toMatchObject({ escalate: true, reason: "MODEL_REQUESTED" });
  });

  it("escalates every DANGEROUS verdict for the action checklist", () => {
    const decision = decideEscalation(
      verdict({ riskLevel: "DANGEROUS", confidence: 0.97 }),
      "ON_DEVICE"
    );
    expect(decision).toMatchObject({ escalate: true, reason: "RISK_LEVEL_HIGH" });
  });

  it("can be configured not to escalate DANGEROUS verdicts", () => {
    const decision = decideEscalation(verdict({ riskLevel: "DANGEROUS", confidence: 0.97 }), "ON_DEVICE", {
      ...DEFAULT_ESCALATION_POLICY,
      escalateDangerous: false
    });
    expect(decision.escalate).toBe(false);
  });

  it("escalates a low-confidence verdict even when it says SAFE", () => {
    const decision = decideEscalation(verdict({ riskLevel: "SAFE", confidence: 0.4 }), "ON_DEVICE");
    expect(decision).toMatchObject({ escalate: true, reason: "CONFIDENCE_BELOW_FLOOR" });
  });

  it("treats the confidence floor as inclusive", () => {
    expect(decideEscalation(verdict({ confidence: 0.6 }), "ON_DEVICE").escalate).toBe(false);
    expect(decideEscalation(verdict({ confidence: 0.599 }), "ON_DEVICE").escalate).toBe(true);
  });

  it("does not escalate twice when the SDK already fell back to the cloud", () => {
    const decision = decideEscalation(
      verdict({ riskLevel: "DANGEROUS", needsCloudEscalation: true }),
      "IN_CLOUD"
    );
    expect(decision.escalate).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it("skips escalation for a confident on-device verdict", () => {
    const decision = decideEscalation(
      verdict({ riskLevel: "SUSPICIOUS", confidence: 0.82 }),
      "ON_DEVICE"
    );
    expect(decision.escalate).toBe(false);
    expect(decision.detail).toMatch(/skipped/);
  });
});

describe("mergeTriageResults", () => {
  it("keeps the higher risk level from either tier", () => {
    const merged = mergeTriageResults(
      verdict({ riskLevel: "DANGEROUS", confidence: 0.7, summary: "on-device alarm" }),
      verdict({ riskLevel: "SAFE", confidence: 0.95, summary: "cloud says fine" })
    );
    expect(merged.riskLevel).toBe("DANGEROUS");
    expect(merged.summary).toBe("on-device alarm");
    expect(merged.confidence).toBe(0.7);
  });

  it("prefers the cloud verdict on a tie", () => {
    const merged = mergeTriageResults(
      verdict({ riskLevel: "SUSPICIOUS", confidence: 0.55, summary: "device" }),
      verdict({ riskLevel: "SUSPICIOUS", confidence: 0.88, summary: "cloud" })
    );
    expect(merged.summary).toBe("cloud");
    expect(merged.confidence).toBe(0.88);
  });

  it("unions signals, cloud first, without duplicates", () => {
    const merged = mergeTriageResults(
      verdict({ riskLevel: "SUSPICIOUS", signals: ["urgency: 24 hours", "gift cards"] }),
      verdict({ riskLevel: "DANGEROUS", signals: ["Gift Cards", "lookalike domain"] })
    );
    expect(merged.signals).toEqual(["Gift Cards", "lookalike domain", "urgency: 24 hours"]);
    expect(merged.signals).toHaveLength(3);
  });

  it("takes the action checklist from the cloud tier", () => {
    const merged = mergeTriageResults(
      verdict({ riskLevel: "DANGEROUS" }),
      verdict({ riskLevel: "DANGEROUS", recommendedActions: ["Do not tap the link"] })
    );
    expect(merged.recommendedActions).toEqual(["Do not tap the link"]);
  });

  it("clears the escalation flag once escalated", () => {
    const merged = mergeTriageResults(
      verdict({ needsCloudEscalation: true }),
      verdict({ needsCloudEscalation: true })
    );
    expect(merged.needsCloudEscalation).toBe(false);
  });
});

describe("describeRoute", () => {
  it("labels each route for the pipeline strip", () => {
    expect(describeRoute("ON_DEVICE_THEN_CLOUD")).toMatch(/escalation/i);
    expect(describeRoute("MOCK_ONLY")).toMatch(/heuristic/i);
  });
});
