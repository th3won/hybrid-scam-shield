import { describe, expect, it } from "vitest";

import {
  MAX_INPUT_CHARS,
  TriageInputError,
  escalateReportToCloud,
  runHybridTriage
} from "../src/ai/hybridTriage";
import type { AiGateway, GenerationOutput, GenerationRequest } from "../src/ai/gateway";
import { MockGateway } from "../src/ai/mockGateway";
import type { InferenceSource, RiskLevel } from "../src/core/types";

interface ScriptStep {
  source: InferenceSource;
  riskLevel: RiskLevel;
  confidence: number;
  needsCloudEscalation?: boolean;
  recommendedActions?: string[];
  /** Override the whole raw text (used for parse-failure tests). */
  rawText?: string;
  /** Throw instead of answering. */
  throwMessage?: string;
}

function verdictJson(step: ScriptStep): string {
  if (step.rawText !== undefined) return step.rawText;
  return JSON.stringify({
    riskLevel: step.riskLevel,
    confidence: step.confidence,
    signals: [`signal from ${step.source}`],
    summary: `verdict from ${step.source}`,
    needsCloudEscalation: step.needsCloudEscalation ?? false,
    ...(step.recommendedActions ? { recommendedActions: step.recommendedActions } : {})
  });
}

class ScriptedGateway implements AiGateway {
  readonly engine = "firebase" as const;
  readonly label = "scripted";
  readonly cloudModel = "gemini-test";
  readonly calls: GenerationRequest[] = [];
  private readonly script: ScriptStep[];

  constructor(script: ScriptStep[]) {
    this.script = [...script];
  }

  async capabilities() {
    return { onDevice: "available" as const, appCheck: true, cloudModel: this.cloudModel };
  }

  async prepareOnDevice(): Promise<void> {
    /* no-op */
  }

  async generate(request: GenerationRequest): Promise<GenerationOutput> {
    this.calls.push(request);
    const step = this.script.shift();
    if (!step) throw new Error("ScriptedGateway ran out of scripted responses");
    if (step.throwMessage) throw new Error(step.throwMessage);
    return { text: verdictJson(step), source: step.source, model: `model-${step.source}` };
  }
}

/** Clock that advances 10 ms per read, so latencies are deterministic. */
function fakeClock(): () => number {
  let now = 0;
  return () => {
    now += 10;
    return now;
  };
}

const SMS = "[KB국민은행] 계좌가 정지되었습니다. http://kb-secure-login.top/verify 에서 공동인증서를 재등록하세요.";

describe("runHybridTriage — AUTO mode", () => {
  it("answers from the on-device model and skips the cloud when confident", async () => {
    const gateway = new ScriptedGateway([
      { source: "ON_DEVICE", riskLevel: "SAFE", confidence: 0.88 }
    ]);
    const report = await runHybridTriage({ text: "See you at the standup tomorrow morning." }, {
      gateway,
      now: fakeClock()
    });

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.mode).toBe("PREFER_ON_DEVICE");
    expect(report.route).toBe("ON_DEVICE_ONLY");
    expect(report.tier1?.source).toBe("ON_DEVICE");
    expect(report.tier2).toBeNull();
    expect(report.escalation).toBeNull();
    expect(report.final.riskLevel).toBe("SAFE");
    expect(report.totalLatencyMs).toBe(30);
    expect(report.notes.join(" ")).toMatch(/skipped/i);
  });

  it("escalates when the on-device verdict asks for it", async () => {
    const gateway = new ScriptedGateway([
      {
        source: "ON_DEVICE",
        riskLevel: "SUSPICIOUS",
        confidence: 0.72,
        needsCloudEscalation: true
      },
      {
        source: "IN_CLOUD",
        riskLevel: "DANGEROUS",
        confidence: 0.93,
        recommendedActions: ["Do not tap the link", "Call 1332"]
      }
    ]);

    const report = await runHybridTriage({ text: SMS, channel: "sms" }, { gateway, now: fakeClock() });

    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[1]?.mode).toBe("CLOUD_ONLY");
    expect(report.route).toBe("ON_DEVICE_THEN_CLOUD");
    expect(report.escalation).toMatchObject({ reason: "MODEL_REQUESTED", automatic: true });
    // Cloud raised the risk level: the merge keeps the more severe one.
    expect(report.final.riskLevel).toBe("DANGEROUS");
    expect(report.final.recommendedActions).toEqual(["Do not tap the link", "Call 1332"]);
    expect(report.final.needsCloudEscalation).toBe(false);
  });

  it("escalates DANGEROUS verdicts for the action checklist", async () => {
    const gateway = new ScriptedGateway([
      { source: "ON_DEVICE", riskLevel: "DANGEROUS", confidence: 0.95 },
      { source: "IN_CLOUD", riskLevel: "DANGEROUS", confidence: 0.96, recommendedActions: ["Block the sender"] }
    ]);

    const report = await runHybridTriage({ text: SMS }, { gateway, now: fakeClock() });

    expect(report.escalation?.reason).toBe("RISK_LEVEL_HIGH");
    expect(report.tier2).not.toBeNull();
    expect(report.final.recommendedActions).toEqual(["Block the sender"]);
  });

  it("escalates a low-confidence SAFE verdict", async () => {
    const gateway = new ScriptedGateway([
      { source: "ON_DEVICE", riskLevel: "SAFE", confidence: 0.35 },
      { source: "IN_CLOUD", riskLevel: "SUSPICIOUS", confidence: 0.7 }
    ]);

    const report = await runHybridTriage({ text: "Short ping, call me back." }, { gateway, now: fakeClock() });

    expect(report.escalation?.reason).toBe("CONFIDENCE_BELOW_FLOOR");
    expect(report.final.riskLevel).toBe("SUSPICIOUS");
  });

  it("does not escalate again when the SDK already fell back to the cloud", async () => {
    const gateway = new ScriptedGateway([
      { source: "IN_CLOUD", riskLevel: "DANGEROUS", confidence: 0.9 }
    ]);

    const report = await runHybridTriage({ text: SMS }, { gateway, now: fakeClock() });

    expect(gateway.calls).toHaveLength(1);
    expect(report.route).toBe("CLOUD_ONLY");
    expect(report.escalation).toBeNull();
    expect(report.notes.join(" ")).toMatch(/fell back|skipped/i);
  });

  it("falls back to the cloud when Tier 1 throws", async () => {
    const gateway = new ScriptedGateway([
      { source: "ON_DEVICE", riskLevel: "SAFE", confidence: 0.5, throwMessage: "Gemini Nano not installed" },
      { source: "IN_CLOUD", riskLevel: "SUSPICIOUS", confidence: 0.8 }
    ]);

    const report = await runHybridTriage({ text: SMS }, { gateway, now: fakeClock() });

    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[1]?.mode).toBe("CLOUD_ONLY");
    expect(report.escalation?.reason).toBe("TIER1_FAILED");
    expect(report.tier1?.source).toBe("IN_CLOUD");
    expect(report.final.riskLevel).toBe("SUSPICIOUS");
  });

  it("keeps the on-device verdict when the cloud escalation fails", async () => {
    const gateway = new ScriptedGateway([
      { source: "ON_DEVICE", riskLevel: "DANGEROUS", confidence: 0.9 },
      { source: "IN_CLOUD", riskLevel: "SAFE", confidence: 0.5, throwMessage: "network down" }
    ]);

    const report = await runHybridTriage({ text: SMS }, { gateway, now: fakeClock() });

    expect(report.tier2).toBeNull();
    expect(report.final.riskLevel).toBe("DANGEROUS");
    expect(report.escalation?.reason).toBe("RISK_LEVEL_HIGH");
    expect(report.notes.join(" ")).toMatch(/escalation failed/i);
  });

  it("treats an unreadable cloud response as a failed escalation", async () => {
    const gateway = new ScriptedGateway([
      { source: "ON_DEVICE", riskLevel: "SUSPICIOUS", confidence: 0.7, needsCloudEscalation: true },
      { source: "IN_CLOUD", riskLevel: "SAFE", confidence: 0.5, rawText: "I think it is fine." }
    ]);

    const report = await runHybridTriage({ text: SMS }, { gateway, now: fakeClock() });

    expect(report.tier2).toBeNull();
    expect(report.final.riskLevel).toBe("SUSPICIOUS");
    expect(report.notes.join(" ")).toMatch(/could not be read|failed/i);
  });
});

describe("runHybridTriage — explicit modes", () => {
  it("CLOUD_ONLY runs a single cloud call", async () => {
    const gateway = new ScriptedGateway([
      { source: "IN_CLOUD", riskLevel: "SUSPICIOUS", confidence: 0.8 }
    ]);

    const report = await runHybridTriage({ text: SMS, mode: "CLOUD_ONLY" }, { gateway, now: fakeClock() });

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.mode).toBe("CLOUD_ONLY");
    expect(report.tier1).toBeNull();
    expect(report.tier2?.source).toBe("IN_CLOUD");
    expect(report.route).toBe("CLOUD_ONLY");
  });

  it("ON_DEVICE_ONLY never escalates, even for DANGEROUS", async () => {
    const gateway = new ScriptedGateway([
      { source: "ON_DEVICE", riskLevel: "DANGEROUS", confidence: 0.99, needsCloudEscalation: true }
    ]);

    const report = await runHybridTriage({ text: SMS, mode: "ON_DEVICE_ONLY" }, { gateway, now: fakeClock() });

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.mode).toBe("ON_DEVICE_ONLY");
    expect(report.tier2).toBeNull();
    expect(report.notes.join(" ")).toMatch(/no cloud escalation/i);
  });

  it("ON_DEVICE_ONLY surfaces a readable error when the model cannot run", async () => {
    const gateway = new ScriptedGateway([
      { source: "ON_DEVICE", riskLevel: "SAFE", confidence: 0.5, throwMessage: "Prompt API unavailable" }
    ]);

    await expect(
      runHybridTriage({ text: SMS, mode: "ON_DEVICE_ONLY" }, { gateway, now: fakeClock() })
    ).rejects.toThrow(/On-device-only scan failed/);
    expect(gateway.calls).toHaveLength(1);
  });
});

describe("runHybridTriage — demo engine", () => {
  it("never calls a network model and tags the result as MOCK", async () => {
    const gateway = new MockGateway({ simulateLatency: false });
    const report = await runHybridTriage({ text: SMS }, { gateway, now: fakeClock() });

    expect(report.route).toBe("MOCK_ONLY");
    expect(report.tier1?.source).toBe("MOCK");
    expect(report.tier2).toBeNull();
    expect(report.final.riskLevel).toBe("DANGEROUS");
  });
});

describe("runHybridTriage — input validation", () => {
  it("rejects empty input", async () => {
    const gateway = new ScriptedGateway([]);
    await expect(runHybridTriage({ text: "   " }, { gateway })).rejects.toBeInstanceOf(TriageInputError);
  });

  it("rejects a message that is too short to judge", async () => {
    const gateway = new ScriptedGateway([]);
    await expect(runHybridTriage({ text: "hi" }, { gateway })).rejects.toThrow(/too short/i);
  });

  it("rejects oversized input", async () => {
    const gateway = new ScriptedGateway([]);
    await expect(
      runHybridTriage({ text: "a".repeat(MAX_INPUT_CHARS + 1) }, { gateway })
    ).rejects.toThrow(/limit/i);
  });
});

describe("escalateReportToCloud", () => {
  it("adds a Tier 2 verdict on demand", async () => {
    const gateway = new ScriptedGateway([
      { source: "ON_DEVICE", riskLevel: "SUSPICIOUS", confidence: 0.85 },
      { source: "IN_CLOUD", riskLevel: "DANGEROUS", confidence: 0.94, recommendedActions: ["Call the bank"] }
    ]);

    const first = await runHybridTriage({ text: SMS }, { gateway, now: fakeClock() });
    expect(first.tier2).toBeNull();

    const escalated = await escalateReportToCloud(first, { gateway, now: fakeClock() });

    expect(escalated.route).toBe("ON_DEVICE_THEN_CLOUD");
    expect(escalated.tier2?.source).toBe("IN_CLOUD");
    expect(escalated.escalation).toMatchObject({ reason: "USER_REQUESTED", automatic: false });
    expect(escalated.final.riskLevel).toBe("DANGEROUS");
    expect(escalated.id).toBe(first.id);
  });

  it("refuses when there is no on-device verdict", async () => {
    const gateway = new ScriptedGateway([
      { source: "IN_CLOUD", riskLevel: "SAFE", confidence: 0.9 }
    ]);
    const report = await runHybridTriage({ text: SMS, mode: "CLOUD_ONLY" }, { gateway, now: fakeClock() });

    await expect(escalateReportToCloud(report, { gateway })).rejects.toThrow(/no on-device verdict/i);
  });

  it("refuses on the demo engine with an actionable message", async () => {
    const gateway = new MockGateway({ simulateLatency: false });
    const report = await runHybridTriage({ text: SMS }, { gateway });
    await expect(escalateReportToCloud(report, { gateway })).rejects.toThrow(/Firebase/);
  });
});
