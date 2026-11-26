import { describe, expect, it } from "vitest";

import {
  TriageParseError,
  extractJsonObject,
  normalizeConfidence,
  normalizeRiskLevel,
  parseTriageResult,
  tryParseTriageResult
} from "../src/core/parse";

const validVerdict = {
  riskLevel: "DANGEROUS",
  confidence: 0.91,
  signals: ["asks to re-register the certificate via kb-secure-login.top"],
  summary: "Bank impersonation asking for certificate re-registration.",
  needsCloudEscalation: true
};

describe("extractJsonObject", () => {
  it("parses a clean JSON object", () => {
    expect(extractJsonObject(JSON.stringify(validVerdict))).toMatchObject({ riskLevel: "DANGEROUS" });
  });

  it("parses a fenced ```json block", () => {
    const raw = "Here is the result:\n```json\n" + JSON.stringify(validVerdict, null, 2) + "\n```\n";
    expect(extractJsonObject(raw)).toMatchObject({ riskLevel: "DANGEROUS" });
  });

  it("parses an object surrounded by prose and trailing text", () => {
    const raw = `Sure! ${JSON.stringify(validVerdict)} Let me know if you need more.`;
    expect(extractJsonObject(raw)).toMatchObject({ summary: validVerdict.summary });
  });

  it("is not confused by braces inside strings", () => {
    const raw = JSON.stringify({ ...validVerdict, summary: "use {this} and }that{ carefully" });
    expect(extractJsonObject(raw)).toMatchObject({ summary: "use {this} and }that{ carefully" });
  });

  it("unwraps an array that contains the verdict", () => {
    expect(extractJsonObject(`[${JSON.stringify(validVerdict)}]`)).toMatchObject({
      riskLevel: "DANGEROUS"
    });
  });

  it("throws for a response without JSON", () => {
    expect(() => extractJsonObject("The message looks fine to me.")).toThrow(TriageParseError);
  });

  it("throws for an empty response", () => {
    expect(() => extractJsonObject("   ")).toThrow(/empty/i);
  });
});

describe("normalizeRiskLevel", () => {
  it("accepts the canonical values", () => {
    expect(normalizeRiskLevel("safe")).toBe("SAFE");
    expect(normalizeRiskLevel("Suspicious")).toBe("SUSPICIOUS");
    expect(normalizeRiskLevel("DANGEROUS")).toBe("DANGEROUS");
  });

  it("maps the synonyms models actually produce", () => {
    expect(normalizeRiskLevel("HIGH")).toBe("DANGEROUS");
    expect(normalizeRiskLevel("phishing")).toBe("DANGEROUS");
    expect(normalizeRiskLevel("medium")).toBe("SUSPICIOUS");
    expect(normalizeRiskLevel("warning")).toBe("SUSPICIOUS");
    expect(normalizeRiskLevel("benign")).toBe("SAFE");
    expect(normalizeRiskLevel("HIGH")).toBe("DANGEROUS");
  });

  it("rejects an unrecognised value", () => {
    expect(() => normalizeRiskLevel("mostly fine")).toThrow(TriageParseError);
  });
});

describe("normalizeConfidence", () => {
  it("keeps 0–1 floats", () => {
    expect(normalizeConfidence(0.42)).toBe(0.42);
    expect(normalizeConfidence("0.8")).toBe(0.8);
  });

  it("converts percentages", () => {
    expect(normalizeConfidence(87)).toBe(0.87);
    expect(normalizeConfidence("85%")).toBe(0.85);
  });

  it("clamps out-of-range values", () => {
    expect(normalizeConfidence(-3)).toBe(0);
  });

  it("returns null for garbage", () => {
    expect(normalizeConfidence("very high")).toBeNull();
    expect(normalizeConfidence(null)).toBeNull();
    expect(normalizeConfidence({})).toBeNull();
  });
});

describe("parseTriageResult", () => {
  it("returns a normalised verdict", () => {
    const result = parseTriageResult(JSON.stringify(validVerdict));
    expect(result).toEqual(validVerdict);
  });

  it("repairs snake_case keys and alias values", () => {
    const raw = JSON.stringify({
      risk_level: "high",
      confidence: "92%",
      signals: "urgency: 24시간 내 미조치\ncredential: 공동인증서 재등록",
      explanation: "계좌 정지를 빙자한 피싱입니다.",
      needs_cloud_escalation: "true"
    });
    const result = parseTriageResult(raw);
    expect(result.riskLevel).toBe("DANGEROUS");
    expect(result.confidence).toBe(0.92);
    expect(result.signals).toHaveLength(2);
    expect(result.needsCloudEscalation).toBe(true);
  });

  it("de-duplicates signals and caps them at eight", () => {
    const signals = ["a", "A", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const result = parseTriageResult(
      JSON.stringify({ ...validVerdict, signals, needsCloudEscalation: false })
    );
    expect(result.signals[0]).toBe("a");
    expect(result.signals).toHaveLength(8);
    expect(new Set(result.signals.map((s) => s.toLowerCase())).size).toBe(8);
  });

  it("accepts action objects", () => {
    const raw = JSON.stringify({
      ...validVerdict,
      recommendedActions: [{ text: "Do not tap the link" }, { action: "Call the bank" }]
    });
    expect(parseTriageResult(raw).recommendedActions).toEqual([
      "Do not tap the link",
      "Call the bank"
    ]);
  });

  it("generates a summary when the model omits one", () => {
    const raw = JSON.stringify({ ...validVerdict, summary: "" });
    expect(parseTriageResult(raw).summary.length).toBeGreaterThan(10);
  });

  it("defaults needsCloudEscalation to true for DANGEROUS when missing", () => {
    const raw = JSON.stringify({
      riskLevel: "DANGEROUS",
      confidence: 0.9,
      signals: ["gift cards"],
      summary: "Gift-card scam."
    });
    expect(parseTriageResult(raw).needsCloudEscalation).toBe(true);
  });

  it("fails with a clear reason when riskLevel is missing", () => {
    const outcome = tryParseTriageResult(JSON.stringify({ confidence: 0.5 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/riskLevel/);
  });

  it("fails when the model answers with prose only", () => {
    expect(() => parseTriageResult("This is definitely a scam.")).toThrow(/JSON verdict/);
  });
});
