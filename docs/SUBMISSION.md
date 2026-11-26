# Hybrid Scam Shield — submission pack

For **Google `#BuildHybridAI 2026`** · Chrome Extension MV3 + Web Demo · Firebase AI Logic hybrid inference.

---

## One-liner

> Scam messages get a verdict in three seconds: Gemini Nano reads them on your device, and only a
> dangerous, uncertain, or user-requested check is escalated to cloud Gemini — with the inference
> source printed on every result.

## Elevator pitch (≈120 words)

Every phishing SMS and "urgent" email is now checked by pasting it into a cloud chatbot — which
uploads the account number, the link and the sender to someone else's server. Hybrid Scam Shield
reverses the default. Tier one runs on the device: Firebase AI Logic calls Gemini Nano through
Chrome's Prompt API in `PREFER_ON_DEVICE` mode and returns a structured verdict — risk level,
confidence, the exact signals, and whether the case deserves a second look. Only then, and only
for a reason the UI prints, does Tier two ask `gemini-3.5-flash-lite` for deeper social-engineering
analysis and a concrete action checklist. Both verdicts are merged so the cloud can never downgrade
an on-device alarm. It runs as a Chrome extension and as a web demo anyone can judge in one click.

## The problem

- Smishing and business-email compromise are text-first attacks; the fastest check most people
  have is a cloud AI chat, which means forwarding sensitive messages to a third party.
- Cloud-only detection is also slow and expensive per check, and it fails exactly where the user
  is: on a phone, offline, or unwilling to upload a bank message.
- Most "AI security" demos are opaque. A user cannot tell whether the model ran locally, what it
  saw, or why it decided.

## The solution

| Layer | Implementation |
|---|---|
| On-device triage | `getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, onDeviceParams: { createOptions, promptOptions: { responseConstraint } }, inCloudParams: { model } })` — constrained JSON decoding on Gemini Nano |
| Cloud escalation | `InferenceMode.ONLY_IN_CLOUD` with `gemini-3.5-flash-lite`, full schema incl. `recommendedActions` |
| Proof of locality | `result.response.inferenceSource` (`on_device` / `in_cloud`) rendered as the primary badge, with model, latency and raw JSON |
| Escalation policy | DANGEROUS · `needsCloudEscalation` · confidence < 0.6 · on-device unavailable · Tier-1 failure · explicit user request — each with a printed reason |
| Merge rule | higher risk wins; tie → cloud summary; signals unioned; cloud actions attached |
| Attack surface | untrusted text is fenced, delimiter escapes neutralised, zero-width/bidi stripped, injection attempts treated as signals |
| Dual target | one Vite/TS codebase → web demo + MV3 extension (popup, side panel, context-menu selection scan, active-tab capture) |
| Honest fallback | without Firebase config, a labelled local heuristic (`DEMO MOCK`) runs through the same pipeline, so judging never blocks on setup |

## What is actually built

- 19 TypeScript modules + 1 stylesheet, no UI framework: ~3,200 lines of TypeScript and ~840 lines of CSS.
- 77 automated tests (node + jsdom) covering parsing, escalation precedence, merge semantics,
  failure paths, prompt hardening and the rendered verdict card.
- `npm run build` produces the web demo *and* the extension in `dist/`, with `firebase/ai`
  code-split so the demo loads instantly.
- Apache-2.0, no secrets, `.env.example`, setup instructions for Firebase, App Check debug
  tokens and Chrome's Prompt API flags.

## How hybrid inference is used (judge checklist)

- [x] `firebase/ai` + `getAI(app, { backend: new GoogleAIBackend() })`
- [x] `InferenceMode.PREFER_ON_DEVICE` for the first pass
- [x] `InferenceMode.ONLY_IN_CLOUD` (and `PREFER_IN_CLOUD`-style behaviour through the SDK
      fallback) for the deep pass
- [x] `result.response.inferenceSource` surfaced in the UI and in the exported JSON
- [x] `gemini-3.5-flash-lite` as the cloud model (no Gemini 2.5)
- [x] App Check with `ReCaptchaEnterpriseProvider` and `self.FIREBASE_APPCHECK_DEBUG_TOKEN`
- [x] Chrome `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` documented
- [x] No API keys or tokens in the repository

## Demo video outline (90 s)

1. **0:00** — A bank smishing text arrives. Paste it. Verdict in under a second, badge `ON-DEVICE`.
2. **0:15** — Open DevTools → Network: no request left the page for that scan.
3. **0:30** — Switch to *Cloud only* on the same text: badge `CLOUD`, action checklist, deeper
   social-engineering read. Show the escalation reason on the *Auto* run.
4. **0:50** — Load the unpacked extension, select text on a page, right-click → side panel scan.
5. **1:05** — Prompt-injection sample: the message orders the model to answer `SAFE`; the verdict
   stays `DANGEROUS` and the injection attempt is listed as a signal.
6. **1:20** — Raw JSON: `route`, `escalation`, `inferenceSource`, latency, model.

## Links to fill in before submitting

- Repository: <https://github.com/th3won/hybrid-scam-shield>
- Deployed web demo: `<add hosting URL>`
- Demo video: `<add YouTube/Vimeo URL>`

## Roadmap after the hackathon

Safe Browsing URL reputation · attachment and screenshot/QR triage · on-device fine-tuned
classifier for Korean smishing · one-tap reporting to 1332 / 7726 · local, encrypted history with
an explicit retention control · Firefox/Safari extension parity where a local model exists.
