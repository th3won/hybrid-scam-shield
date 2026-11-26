/**
 * Local demo heuristic ("mock engine").
 *
 * Purpose: the project must be judgeable *before* anyone creates a Firebase
 * project. This module produces a deterministic verdict from an explainable
 * rule table, then returns it as the same JSON shape the real models return, so
 * the rest of the pipeline (parsing, escalation policy, UI, tests) runs for real.
 *
 * It is NOT an AI model and never claims to be: every result it produces is
 * tagged `MOCK` and the UI shows a "demo heuristic" badge.
 */

import { buildTriagePrompt, type TriagePromptInput } from "./prompts";
import { parseTriageResult } from "./parse";
import type { RiskLevel, TriageResult } from "./types";

interface Rule {
  id: string;
  weight: number;
  /** Short, human-readable description of the cue. */
  label: string;
  /** Same label in Korean, used when the message is Korean. */
  labelKo: string;
  pattern: RegExp;
}

/** Weights are tuned so that a single weak cue never reaches DANGEROUS. */
const RULES: Rule[] = [
  {
    id: "credential_request",
    weight: 3,
    label: "Asks for a password, code, certificate or ID",
    labelKo: "비밀번호·인증번호·공동인증서를 요구",
    pattern:
      /(password|passcode|\botp\b|one[- ]?time (code|password)|verification code|공동인증서|인증번호|비밀번호|주민등록|신분증|카드\s*번호)/i
  },
  {
    id: "payment_request",
    weight: 2.5,
    label: "Requests payment in an irreversible form",
    labelKo: "되돌릴 수 없는 수단으로 결제 요구(상품권·코인·송금)",
    pattern:
      /(gift card|itunes card|google play card|상품권|bitcoin|\bbtc\b|\busdt\b|crypto wallet|wire transfer|송금|입금해|계좌로\s*보내)/i
  },
  {
    id: "prize_lure",
    weight: 2.5,
    label: "Uses a prize, refund or subsidy as bait",
    labelKo: "당첨·환급·지원금을 미끼로 사용",
    pattern:
      /(당첨|경품|lottery|you('ve| have) won|\bprize\b|환급금|지원금|\bsubsidy\b|\brefund\b)/i
  },
  {
    id: "investment_lure",
    weight: 2.5,
    label: "Promises guaranteed or risk-free returns",
    labelKo: "확정 수익·원금 보장을 약속",
    pattern:
      /(guaranteed (return|profit)|수익\s*보장|원금\s*보장|risk[- ]free|double your|\b\d{3}%\b|고수익|trading bot)/i
  },
  {
    id: "suspicious_domain",
    weight: 2.2,
    label: "Links to an unexpected domain or a URL shortener",
    labelKo: "의심 도메인·단축 링크로 유도",
    pattern:
      /(https?:\/\/[^\s"'<>]*\.(top|xyz|click|ru|tk|ml|ga|cf|gq|buzz|shop|live|info)\b|https?:\/\/\d{1,3}(\.\d{1,3}){3}|bit\.ly|tinyurl\.com|is\.gd|rb\.gy)/i
  },
  {
    id: "threat",
    weight: 2,
    label: "Threatens account closure, legal action or loss",
    labelKo: "계좌 정지·법적 조치로 압박",
    pattern:
      /(영구\s*정지|계좌\s*정지|압류|체납|고발|법적\s*조치|\barrest\b|\bwarrant\b|\blawsuit\b|account (will be|has been) (suspended|closed|blocked)|legal action|permanently (locked|closed)|폐기\s*처리|반송)/i
  },
  {
    id: "secrecy",
    weight: 1.5,
    label: "Asks the reader not to call or tell anyone",
    labelKo: "통화·공유를 하지 말라고 요구",
    pattern: /(don'?t (call|tell)|keep this between|비밀|아무에게도\s*말하지|말하지\s*마)/i
  },
  {
    id: "impersonation",
    weight: 1.8,
    label: "Speaks as a bank, agency or executive",
    labelKo: "은행·기관·임원을 사칭",
    pattern:
      /(국세청|검찰|경찰|금융감독원|관세청|\bcustoms\b|\birs\b|tax office|national tax service|social security|\bprosecutor\b|\bpolice\b|은행\s*직원|bank (security|fraud) team|\bceo\b|대표님|사장님)/i
  },
  {
    id: "job_lure",
    weight: 1.6,
    label: "Recruits for an easy, unusually well-paid job",
    labelKo: "고수익·무경험 아르바이트로 유인",
    pattern:
      /(part[- ]time|부업|재택\s*알바|daily pay|일당|high income|고수익\s*알바|no experience)/i
  },
  {
    id: "delivery",
    weight: 1.2,
    label: "Claims a parcel or delivery problem",
    labelKo: "택배·배송 문제를 언급",
    pattern:
      /(택배|배송지|통관|customs fee|\bparcel\b|delivery (failed|attempt)|\bcourier\b)/i
  },
  {
    id: "personal_money_request",
    weight: 1.6,
    label: "Asks for money as a favour",
    labelKo: "지인인 척 금전을 요구",
    pattern:
      /(send me (money|cash)|send me\s+[\d,.]+\s*(won|원|usd|dollars?)|송금해|돈\s*좀\s*보내|급하게\s*돈|계좌번호)/i
  },
  {
    id: "money_mule",
    weight: 2.2,
    label: "Wants payments routed through your account",
    labelKo: "계좌로 자금을 받아 넘기게 유도",
    pattern:
      /(forward (the )?(payment|funds|money)|receive payments|payment processing|money mule|자금\s*세탁|계좌로\s*받아)/i
  },
  {
    id: "new_number",
    weight: 1.2,
    label: "Explains a sudden change of phone number",
    labelKo: "갑작스러운 번호 변경을 설명",
    pattern: /(new (phone )?number|번호가\s*바뀌|this is a new number)/i
  },
  {
    id: "brand_mention",
    weight: 0.8,
    label: "Names a well-known brand or bank",
    labelKo: "유명 브랜드·은행 이름을 언급",
    pattern:
      /(kb국민은행|신한은행|우리은행|하나은행|국민카드|삼성카드|쿠팡|coupang|paypal|amazon|apple|cj대한통운)/i
  }
];

const DANGEROUS_THRESHOLD = 5.5;
const SUSPICIOUS_THRESHOLD = 2;

export interface MockEngineOptions {
  /** Optional artificial delay so the demo shows a realistic pipeline. */
  simulateLatencyMs?: number;
}

interface Hit {
  rule: Rule;
  excerpt: string;
}

/** Score a message with the demo rule table. Exposed for tests and debugging. */
export function scoreMessage(text: string): { score: number; hits: Hit[] } {
  const hits: Hit[] = [];
  let score = 0;
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    score += rule.weight;
    hits.push({ rule, excerpt: excerptAround(text, match.index, match[0].length) });
  }
  return { score: Math.round(score * 10) / 10, hits };
}

/** Deterministic verdict for the demo. Same input always yields the same output. */
export function mockTriage(text: string): TriageResult {
  const trimmed = text.trim();
  const { score, hits } = scoreMessage(trimmed);
  const riskLevel: RiskLevel =
    score >= DANGEROUS_THRESHOLD ? "DANGEROUS" : score >= SUSPICIOUS_THRESHOLD ? "SUSPICIOUS" : "SAFE";

  const korean = /[\u3131-\uD79D]/.test(trimmed);
  const confidence = confidenceFor(riskLevel, score);
  const signals =
    riskLevel === "SAFE"
      ? [
          korean ? "긴급성·위협·자격증명 요구 신호 없음" : "No urgency, threat or credential-request cues",
          korean ? "의심 도메인 링크 없음" : "No suspicious or shortened links",
          korean ? "금전·상품권·암호화폐 요구 없음" : "No payment, gift-card or crypto request"
        ]
      : hits
          .slice(0, 6)
          .map((hit) => `${korean ? hit.rule.labelKo : hit.rule.label}: “${hit.excerpt}”`);

  const summary = buildSummary(riskLevel, korean, hits);
  const needsCloudEscalation = score >= 3.5 && score < DANGEROUS_THRESHOLD;

  const result: TriageResult = {
    riskLevel,
    confidence,
    signals,
    summary,
    needsCloudEscalation
  };

  if (riskLevel !== "SAFE") {
    result.recommendedActions = korean
      ? [
          "메시지의 링크를 누르지 말고, 공식 앱이나 대표번호로 직접 확인하세요.",
          "비밀번호·인증번호·공동인증서는 절대 입력하거나 전달하지 마세요.",
          "송금·상품권 구매 요청은 가족이나 동료에게 먼저 확인하세요.",
          "의심스러우면 112 또는 금융감독원 1332에 신고하세요."
        ]
      : [
          "Do not tap any link. Open the company's official app or type its address yourself.",
          "Never enter or share a password, one-time code, certificate or card number.",
          "Verify any payment request with the person through a number you already have.",
          "Report the message to your carrier or national fraud line (US: 7726, KR: 1332)."
        ];
  }

  return result;
}

/** Same contract as a real gateway call: returns the raw JSON text a model would produce. */
export function mockGenerate(request: TriagePromptInput): string {
  return JSON.stringify(mockTriage(request.text));
}

/** Build a prompt (kept for parity with the real gateway) and parse it back. */
export function mockRoundTrip(request: TriagePromptInput): TriageResult {
  return parseTriageResult(mockGenerate({ ...request, text: request.text }));
}

function confidenceFor(level: RiskLevel, score: number): number {
  let value: number;
  if (level === "DANGEROUS") value = 0.62 + (score - DANGEROUS_THRESHOLD) * 0.05;
  else if (level === "SUSPICIOUS") value = 0.55 + (score - SUSPICIOUS_THRESHOLD) * 0.05;
  else value = 0.6 + (SUSPICIOUS_THRESHOLD - score) * 0.08;
  return Math.round(Math.min(0.95, Math.max(0.5, value)) * 100) / 100;
}

function buildSummary(level: RiskLevel, korean: boolean, hits: Hit[]): string {
  const labels = hits.slice(0, 3).map((hit) => (korean ? hit.rule.labelKo : hit.rule.label));
  if (level === "SAFE") {
    return korean
      ? "이 메시지에서는 사기나 피싱의 뚜렷한 신호가 발견되지 않았습니다. 다만 링크와 발신자는 공식 채널에서 다시 확인하는 습관이 좋습니다."
      : "No clear scam or phishing indicators were found. Still, confirm links and senders through an official channel before acting.";
  }
  if (level === "DANGEROUS") {
    return korean
      ? `사기 가능성이 높습니다. 다음 신호가 함께 나타납니다 — ${labels.join(
          " · "
        )}. 링크를 누르거나 정보를 입력하지 마세요.`
      : `This is very likely a scam. Several strong cues appear together — ${labels.join(
          ", "
        )}. Do not tap links or share information.`;
  }
  return korean
    ? `회색지대의 메시지입니다. ${labels.join(
        " · "
      )} 신호가 보이지만 정상 공지일 가능성도 남아 있습니다. 발신자를 공식 채널로 확인하세요.`
    : `This sits in the grey zone: ${labels.join(
        ", "
      )}. It could still be legitimate — verify the sender through an official channel.`;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 18);
  const end = Math.min(text.length, index + length + 18);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

export { buildTriagePrompt };
