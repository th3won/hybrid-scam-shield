# 🛡️ Hybrid Scam Shield

**Three seconds to a scam verdict — computed on your device, escalated to the cloud only when it matters.**

A Chrome extension (MV3) **and** a hosted web demo, built with Vite + TypeScript on
**Firebase AI Logic hybrid inference**: Gemini Nano on-device first, `gemini-3.5-flash-lite`
in the cloud only when the verdict is dangerous, uncertain, or asks for a deeper look.

---

## Why this exists

Bank smishing, delivery scams and "your CEO needs gift cards" emails all arrive as text. The
fastest way to check one today is to paste it into a cloud chatbot — which uploads the message,
the account number and the link to a remote server, and leaves it in a chat history.

Hybrid Scam Shield flips the default: **the first analysis runs on the device**. The message
leaves the machine only when a rule we can show on screen says a cloud model would change the
answer. The UI proves it: every verdict carries the real `result.response.inferenceSource` —
`ON-DEVICE` or `CLOUD` — plus the model name, the latency and the raw JSON.

## What you get

| | |
|---|---|
| **Tier 1 — on-device triage** | `getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, ... })`. Chrome runs Gemini Nano through the Prompt API; Firebase AI Logic wraps it and reports where inference happened. Returns `{ riskLevel, confidence, signals, summary, needsCloudEscalation }`. |
| **Tier 2 — cloud deep analysis** | `InferenceMode.ONLY_IN_CLOUD` with `gemini-3.5-flash-lite`, a fuller JSON schema and a concrete action checklist. Triggered only by the escalation policy or by the user. |
| **Two targets, one codebase** | Chrome extension (popup + side panel + right-click "Scan selection" + active-tab text capture) and a standalone web demo with one-click sample messages. |
| **Honest demo mode** | With no Firebase config the app runs a labelled local heuristic (`DEMO MOCK`) through the *same* pipeline, parser, escalation rules and UI — so judges can try it before creating a project, and nobody mistakes a rule table for a model. |
| **Explainability** | Signals quote the actual cue, the escalation reason is printed, and the raw report JSON is one click away. |

## Try it in 30 seconds

```bash
npm install
npm run dev          # → http://localhost:5173  (web demo, demo heuristic, zero config)
```

Press a sample chip (은행 사칭 문자 / CEO 사칭 + 상품권 / prompt injection / safe messages) and the
scan runs immediately. Every card tells you which engine answered.

With Firebase configured the same button runs Gemini Nano and escalates to
`gemini-3.5-flash-lite` — see [Firebase setup](#firebase-setup).

---

## Architecture

```
                       ┌───────────────────────────────┐
   Chrome Extension    │  popup.html (popup + side panel)│──┐
   (MV3)               │  background.js (context menu,   │  │
                       │  session storage, side panel)   │  │
                       └───────────────────────────────┘  │
                                                          │  same UI bundle
                       ┌───────────────────────────────┐  │
   Web demo            │  index.html                   │──┤
                       └───────────────────────────────┘  │
                                                          ▼
                                        ┌──────────────────────────────────┐
                                        │ src/ui/app.ts  (vanilla TS)      │
                                        │ verdict card · source badge ·    │
                                        │ pipeline strip · raw JSON        │
                                        └───────────────┬──────────────────┘
                                                        ▼
                                        ┌──────────────────────────────────┐
                                        │ src/ai/hybridTriage.ts           │
                                        │ Tier 1 → policy → Tier 2 → merge │
                                        └───────┬───────────────┬──────────┘
                                                ▼               ▼
                                   ┌─────────────────┐  ┌──────────────────────┐
                                   │ On-device tier  │  │ Cloud tier           │
                                   │ PREFER_ON_DEVICE│  │ ONLY_IN_CLOUD        │
                                   │ Gemini Nano     │  │ gemini-3.5-flash-lite│
                                   └────────┬────────┘  └──────────┬───────────┘
                                            └──────────┬───────────┘
                                                       ▼
                                   ┌──────────────────────────────────────┐
                                   │ firebase/ai · Firebase AI Logic      │
                                   │ result.response.inferenceSource      │
                                   └──────────────────────────────────────┘
```

### The routing rules (all unit-tested)

| Situation | What runs | Reason shown to the user |
|---|---|---|
| Default (`Auto`) | Tier 1 with `PREFER_ON_DEVICE` | — |
| On-device verdict is DANGEROUS | Tier 2 added | `RISK_LEVEL_HIGH` |
| `needsCloudEscalation: true` | Tier 2 added | `MODEL_REQUESTED` |
| Confidence < 60 % (any risk level, including SAFE) | Tier 2 added | `CONFIDENCE_BELOW_FLOOR` |
| Gemini Nano missing → SDK answers in the cloud | Tier 2 skipped (already cloud) | source badge shows `CLOUD` |
| Tier 1 throws (no model, network) | Same prompt retried in the cloud | `TIER1_FAILED` |
| `On-device only` strategy | Tier 1 only, never the cloud | — |
| `Cloud only` strategy / "Deep cloud check" | Tier 2 only / added on demand | `USER_REQUESTED` |

Merging is deliberately conservative: **the higher risk level wins**, so the cloud can never
quietly downgrade an on-device alarm; on a tie the cloud summary wins; signals are unioned.

Input is treated as hostile: the message is fenced in `<untrusted_message>` tags, closing tags
inside it are neutralised, zero-width/bidi characters are stripped, and the model is instructed
that "ignore previous instructions" inside the message is itself evidence. There is a
prompt-injection sample preset to demonstrate it.

---

## Quickstart

Requirements: **Node 20+** (verified on 20.18.1) and a Chromium browser for the extension.

```bash
git clone <your-fork> hybrid-scam-shield
cd hybrid-scam-shield
npm install
cp .env.example .env     # optional — leave empty to run the demo heuristic

npm run dev              # web demo   → http://localhost:5173
npm test                 # 77 unit + DOM tests
npm run build            # typecheck + web demo and extension in dist/
```

`npm install` may print `EBADENGINE` warnings from Firebase's Node `>=24` declaration. They are
about Node-side rendering; the browser build in this project is unaffected.

---

## Firebase setup

1. **Create / pick a project** at <https://console.firebase.google.com>.
2. **Upgrade to the Blaze plan.** Firebase AI Logic bills per token; the free Spark plan cannot
   call Gemini models.
3. **Enable AI Logic** → *Build → AI Logic* → choose **Gemini Developer API** as the backend.
   Your project gets a Gemini API key managed by Firebase; no key goes into this repo.
4. **Register a Web app** (Project settings → General → Your apps → `</>`), copy the config into
   `.env`:

   ```dotenv
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project
   VITE_FIREBASE_APP_ID=1:...:web:...
   ```

5. **App Check** (strongly recommended; required before production):
   - *App Check → Apps → your web app → reCAPTCHA Enterprise*.
   - Create the reCAPTCHA Enterprise key in Google Cloud, register your domains
     (`localhost` for development, your hosting domain, and `chrome-extension://<extension-id>`
     for the extension build), paste the **site key** into `VITE_FIREBASE_APP_CHECK_SITE_KEY`.
   - For local development set `VITE_FIREBASE_APP_CHECK_DEBUG=true`, run once, and copy the
     debug token printed in the console into *App Check → Manage debug tokens*. The app sets
     `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` **before** `initializeAppCheck`, as required.
   - Never ship a build with the debug flag on.
6. **Model name.** The default is `gemini-3.5-flash-lite` (not the retired Gemini 2.5 family).
   Override with `VITE_AI_CLOUD_MODEL` if your project exposes a different alias.
7. Restart `npm run dev`. The banner disappears and the engine chip switches to
   **Firebase AI Logic**.

## Enable Gemini Nano (on-device tier)

Chrome 138+ on desktop, ~22 GB free disk, 4 GB+ VRAM (or a supported CPU path):

1. `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → **Enabled**
2. `chrome://flags/#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**
3. Restart Chrome.
4. `chrome://on-device-internals` → wait until the model state is *Ready* (the download can take
   a while; it continues in the background).

The app never starts that download by itself: the chip in the header shows the availability that
Chrome reports (`LanguageModel.availability()`), and preparing the model is an explicit action.
If Nano is unavailable the SDK silently falls back to the cloud model and the card says `CLOUD`.

---

## Build and load the extension

```bash
npm run build
```

`dist/` then contains **both** targets:

```
dist/index.html      ← host this anywhere: the web demo
dist/popup.html      ← extension popup + side panel
dist/background.js   ← MV3 service worker
dist/manifest.json   ← extension manifest
dist/assets/*        ← shared hashed chunks (firebase/ai loads lazily)
dist/icons/*
```

Load it:

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → select `dist/`.
2. Pin the toolbar icon → paste a message → **Scan message**.
3. Select text on any page → right-click → **Scan with Hybrid Scam Shield** → the side panel
   opens with the selection and scans it automatically.
4. In the popup, **Use current tab's selection** reads the selection (or the visible page text
   when nothing is selected) through `chrome.scripting` — no content script is injected
   permanently, and the permission is `activeTab` only.

> The extension origin (`chrome-extension://<id>`) must be registered on the reCAPTCHA Enterprise
> key, otherwise App Check will reject the cloud calls. The on-device tier keeps working without it.

---

## Environment variables

All optional. Without the four required Firebase values the app runs the demo heuristic.

| Variable | Purpose |
|---|---|
| `VITE_FIREBASE_API_KEY` | Web app API key (public identifier, not a secret) |
| `VITE_FIREBASE_AUTH_DOMAIN` | Web app auth domain |
| `VITE_FIREBASE_PROJECT_ID` | Project id |
| `VITE_FIREBASE_APP_ID` | Web app id |
| `VITE_FIREBASE_STORAGE_BUCKET` | Optional |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Optional |
| `VITE_FIREBASE_MEASUREMENT_ID` | Optional |
| `VITE_FIREBASE_APP_CHECK_SITE_KEY` | reCAPTCHA Enterprise site key for App Check |
| `VITE_FIREBASE_APP_CHECK_DEBUG` | `true` only while developing; sets the SDK debug token |
| `VITE_AI_CLOUD_MODEL` | Cloud model, default `gemini-3.5-flash-lite` |

Never put a service-account JSON, a Gemini API key, or a registered App Check debug token in
`.env`, in the bundle, or in this repository.

---

## Testing

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

77 tests, no network and no Firebase project needed:

- **`tests/router.test.ts`** — every escalation rule and its precedence, the confidence floor
  boundary, the "SDK already used the cloud" guard, merge semantics (higher risk wins, tie →
  cloud, signal union, action list), route labels.
- **`tests/parse.test.ts`** — fenced / prose-wrapped / array-wrapped JSON, boolean and
  percentage coercion, risk-level synonyms (`HIGH`, `phishing`, `medium`…), signal de-duplication
  and caps, missing-field failures with readable reasons.
- **`tests/hybridTriage.test.ts`** — a scripted gateway drives the whole orchestrator: on-device
  success, model-requested escalation, dangerous escalation, low-confidence escalation, SDK cloud
  fallback, Tier 1 failure → cloud retry, cloud failure → on-device verdict, unreadable model
  output, cloud-only, on-device-only, demo mode, input validation, manual deep check.
- **`tests/mockEngine.test.ts`** — every sample preset matches its expected verdict, determinism,
  language of the summary, prompt fencing / injection neutralisation.
- **`tests/ui.test.ts`** — mounts the real UI in jsdom, clicks a sample, asserts the rendered
  verdict, source badge, actions, pipeline and raw JSON.

## Project structure

```
hybrid-scam-shield/
├─ index.html                 web demo entry
├─ popup.html                 extension popup + side panel entry
├─ vite.config.ts             multi-entry build → dist/ (web + extension)
├─ public/manifest.json       MV3 manifest (copied verbatim)
├─ public/icons/              generated icons
├─ src/
│  ├─ core/                   pure logic, no I/O
│  │  ├─ types.ts             verdict / report / route types
│  │  ├─ parse.ts             tolerant model-output parsing
│  │  ├─ router.ts            escalation policy + merge
│  │  ├─ prompts.ts           system prompt, JSON schemas, injection defence
│  │  ├─ mockEngine.ts        explainable demo heuristic
│  │  └─ presets.ts           sample messages (ko/en)
│  ├─ ai/
│  │  ├─ gateway.ts           provider interface
│  │  ├─ firebaseGateway.ts   firebase/app + app-check + firebase/ai (hybrid)
│  │  ├─ mockGateway.ts       demo provider
│  │  ├─ engine.ts            picks the gateway, never pretends
│  │  ├─ onDevice.ts          LanguageModel availability probe
│  │  ├─ config.ts            env parsing
│  │  └─ hybridTriage.ts      Tier 1 → policy → Tier 2 → merge
│  ├─ ui/                     shell, cards, styles
│  ├─ demo/main.ts            web entry
│  └─ extension/              popup.ts, background.ts
├─ tests/                     vitest (node + jsdom)
├─ docs/SUBMISSION.md         hackathon write-up + demo script
├─ .env.example
├─ LICENSE                    Apache-2.0
└─ README.md
```

## Privacy & security notes

- **No analytics, no third-party scripts, no remote code.** MV3 CSP keeps `script-src 'self'`.
- **No message storage.** A report lives in memory only; the context-menu path stashes the
  selection in `chrome.storage.session`, which is cleared when the browser closes and is removed
  as soon as the panel reads it.
- **Nothing is uploaded by Tier 1** when the on-device model answers — the badge proves it.
- **App Check** (reCAPTCHA Enterprise) gates cloud calls; the debug token path is development-only.
- **Prompt injection is treated as evidence**, not as an instruction, and is demonstrated in a sample.
- The Firebase Web API key is a public project identifier; protect the project with App Check,
  API key restrictions and quota alerts, not by hiding the key.

## Limitations

- Gemini Nano availability depends on Chrome version, OS and hardware; the cloud fallback is the
  designed answer, not a bug.
- The demo heuristic is a small rule table. It is labelled `DEMO MOCK` everywhere and must never
  be used as a real security decision.
- URL reputation (Safe Browsing), attachment inspection, screenshot/QR analysis and a
  "report to 1332/7726" flow are natural next steps; only text triage ships today.
- Korean and English are the tuned languages; the prompt asks the model to answer in the language
  of the message, so other languages work but are unverified.

## Three-minute judging script

1. **15 s** — Open the web demo, press *은행 사칭 문자*: verdict card appears with
   `DANGEROUS`, quoted signals and an action checklist; the chip reads **DEMO MOCK**.
2. **40 s** — Fill `.env`, reload: the chip switches to **Firebase AI Logic** and the header shows
   **Nano ready**. Press the same sample: the badge now reads **ON-DEVICE**, latency ~300 ms, no
   network call in DevTools.
3. **60 s** — *Auto* escalates a DANGEROUS verdict: the pipeline shows Tier 1 `ON-DEVICE` →
   `RISK_LEVEL_HIGH` → Tier 2 `CLOUD` with `gemini-3.5-flash-lite`, and the action checklist.
4. **40 s** — Choose *On-device only*: the cloud tier is skipped and the card says the message
   never left the device. Then *Deep cloud check* to add Tier 2 on demand.
5. **30 s** — Load the unpacked extension, select a smishing text on a page, right-click → side
   panel scans it. Open the raw JSON to show `inferenceSource`, `route` and the escalation record.
6. **15 s** — Press the *prompt injection* sample: the message tries to force `SAFE`; the verdict
   stays `DANGEROUS` and the injection attempt appears as a signal.

## License

Apache-2.0. See [LICENSE](LICENSE).
