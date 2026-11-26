/**
 * The shared UI, mounted identically by the web demo and by the extension
 * popup / side panel.
 *
 * The card is built around one promise: the user must be able to see, at a
 * glance, whether the verdict came from their device or from the cloud. That is
 * why `inferenceSource` is a first-class badge and why the pipeline strip and
 * the raw JSON are always one click away.
 */

import { escalateReportToCloud, runHybridTriage, MAX_INPUT_CHARS } from "../ai/hybridTriage";
import { selectEngine, type EngineSelection } from "../ai/engine";
import type { GatewayCapabilities } from "../ai/gateway";
import { describeAvailability } from "../ai/onDevice";
import { DEMO_PRESETS, type DemoPreset } from "../core/presets";
import { describeRoute, formatPercent } from "../core/router";
import type { HybridTriageReport, ScanMode, TierRun } from "../core/types";
import { severityOf } from "../core/types";
import {
  copyText,
  downloadText,
  esc,
  formatCount,
  formatMs,
  percent,
  riskHeadline,
  riskIcon,
  riskTone,
  sourceHelp,
  sourceIcon,
  sourceLabel,
  sourceTone
} from "./format";
import "./styles.css";

export interface AppOptions {
  surface: "web" | "extension";
  initialText?: string;
  /** Run the scan as soon as the engine is ready (used by the context-menu entry). */
  autoScan?: boolean;
  /** Extension only: read the current tab's selection or page text. */
  capturePageText?: () => Promise<{ text: string; kind: string }>;
  openSidePanel?: () => Promise<void> | void;
}

interface AppState {
  text: string;
  channel: string;
  mode: ScanMode;
  busy: boolean;
  report: HybridTriageReport | null;
  error: string | null;
  notice: string | null;
  engine: EngineSelection | null;
  capabilities: GatewayCapabilities | null;
  preparing: number | null;
  copied: boolean;
}

export function mountApp(root: HTMLElement, options: AppOptions): void {
  root.innerHTML = shellTemplate(options);

  const els = {
    presets: must<HTMLElement>(root, "#presets"),
    input: must<HTMLTextAreaElement>(root, "#input"),
    charCount: must<HTMLElement>(root, "#charCount"),
    deviceHint: must<HTMLElement>(root, "#deviceHint"),
    mode: must<HTMLSelectElement>(root, "#mode"),
    scanBtn: must<HTMLButtonElement>(root, "#scanBtn"),
    clearBtn: must<HTMLButtonElement>(root, "#clearBtn"),
    captureRow: must<HTMLElement>(root, "#captureRow"),
    captureBtn: must<HTMLButtonElement>(root, "#captureBtn"),
    sidePanelBtn: must<HTMLButtonElement>(root, "#sidePanelBtn"),
    result: must<HTMLElement>(root, "#result"),
    engineSlot: must<HTMLElement>(root, "#engineSlot"),
    banner: must<HTMLElement>(root, "#banner"),
    bannerTitle: must<HTMLElement>(root, "#bannerTitle"),
    bannerText: must<HTMLElement>(root, "#bannerText"),
    bannerAction: must<HTMLButtonElement>(root, "#bannerAction"),
    howBtn: must<HTMLButtonElement>(root, "#howBtn"),
    dialog: must<HTMLDialogElement>(root, "#howDialog"),
    dialogClose: must<HTMLButtonElement>(root, "#dialogClose")
  };

  const state: AppState = {
    text: options.initialText ?? "",
    channel: "unknown",
    mode: "AUTO",
    busy: false,
    report: null,
    error: null,
    notice: null,
    engine: null,
    capabilities: null,
    preparing: null,
    copied: false
  };

  els.input.value = state.text;
  updateCount();

  if (options.capturePageText) {
    els.captureRow.hidden = false;
  }
  if (!options.openSidePanel) {
    els.sidePanelBtn.hidden = true;
  }

  renderPresets();
  renderResult();

  // ── input ────────────────────────────────────────────────────────────────
  els.input.addEventListener("input", () => {
    state.text = els.input.value;
    state.channel = detectChannel(state.text);
    state.error = null;
    updateCount();
  });

  els.input.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runScan();
    }
  });

  els.presets.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-preset]");
    if (!target) return;
    const preset = DEMO_PRESETS.find((item) => item.id === target.dataset.preset);
    if (!preset) return;
    applyPreset(preset);
    void runScan();
  });

  els.mode.addEventListener("change", () => {
    state.mode = els.mode.value as ScanMode;
  });

  els.scanBtn.addEventListener("click", () => void runScan());
  els.clearBtn.addEventListener("click", () => {
    state.text = "";
    state.channel = "unknown";
    state.report = null;
    state.error = null;
    state.notice = null;
    els.input.value = "";
    els.input.focus();
    updateCount();
    renderResult();
  });

  els.captureBtn.addEventListener("click", () => void captureFromPage());
  els.sidePanelBtn.addEventListener("click", () => void options.openSidePanel?.());

  els.howBtn.addEventListener("click", () => els.dialog.showModal());
  els.dialogClose.addEventListener("click", () => els.dialog.close());
  els.dialog.addEventListener("click", (event) => {
    if (event.target === els.dialog) els.dialog.close();
  });

  els.bannerAction.addEventListener("click", () => els.dialog.showModal());

  // ── result card (delegated: the panel is re-rendered often) ──────────────
  els.result.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "copy" && state.report) {
      void copyText(JSON.stringify(state.report, null, 2)).then((ok) => {
        state.copied = ok;
        state.notice = ok ? null : "Copy failed — select the JSON below instead.";
        renderResult();
        if (ok) setTimeout(() => { state.copied = false; renderResult(); }, 1600);
      });
    }
    if (action === "download" && state.report) {
      downloadText(`scam-shield-${state.report.id.slice(0, 8)}.json`, JSON.stringify(state.report, null, 2));
    }
    if (action === "deep") void runDeepCheck();
    if (action === "sample") {
      const preset = DEMO_PRESETS.find((item) => item.id === target.dataset.preset);
      if (preset) { applyPreset(preset); void runScan(); }
    }
  });

  // ── engine ───────────────────────────────────────────────────────────────
  void bootEngine();

  function updateCount(): void {
    els.charCount.textContent = `${formatCount(state.text.length)} / ${formatCount(MAX_INPUT_CHARS)}`;
    els.charCount.classList.toggle("is-over", state.text.length > MAX_INPUT_CHARS);
  }

  function applyPreset(preset: DemoPreset): void {
    state.text = preset.text;
    state.channel = preset.channel;
    state.report = null;
    state.error = null;
    state.notice = null;
    els.input.value = preset.text;
    updateCount();
    renderResult();
  }

  async function bootEngine(): Promise<void> {
    renderEngineArea();
    const selection = await selectEngine();
    state.engine = selection;
    updateDeviceHint();
    renderEngineArea();
    renderBanner();
    renderResult();
    if (selection.mode === "firebase") {
      try {
        state.capabilities = await selection.gateway.capabilities();
      } catch {
        state.capabilities = null;
      }
      renderEngineArea();
      renderBanner();
      updateDeviceHint();
    }
    if (options.autoScan && state.text.trim().length > 0) {
      void runScan();
    }
  }

  function updateDeviceHint(): void {
    const caps = state.capabilities;
    if (!state.engine || state.engine.mode === "mock") {
      els.deviceHint.textContent = "demo heuristic · nothing leaves this device";
      return;
    }
    if (!caps) {
      els.deviceHint.textContent = "Gemini Nano status unknown";
      return;
    }
    els.deviceHint.textContent = describeAvailability(caps.onDevice).toLowerCase();
  }

  async function captureFromPage(): Promise<void> {
    if (!options.capturePageText) return;
    els.captureBtn.disabled = true;
    els.captureBtn.textContent = "Reading the tab…";
    try {
      const captured = await options.capturePageText();
      state.text = captured.text;
      state.channel = captured.kind === "selection" ? "selection" : "page";
      els.input.value = captured.text;
      updateCount();
      state.notice =
        captured.kind === "selection"
          ? "Loaded the selected text from the active tab."
          : "No text was selected, so the visible page text was loaded. Trim it if it is long.";
      renderResult();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      renderResult();
    } finally {
      els.captureBtn.disabled = false;
      els.captureBtn.textContent = "Use current tab's selection";
    }
  }

  async function runScan(): Promise<void> {
    if (state.busy) return;
    const gateway = state.engine?.gateway;
    if (!gateway) {
      state.error = "The engine is still starting. Try again in a second.";
      renderResult();
      return;
    }
    state.text = els.input.value;
    state.busy = true;
    state.report = null;
    state.error = null;
    state.notice = null;
    state.copied = false;
    renderResult();
    try {
      state.report = await runHybridTriage(
        { text: state.text, channel: state.channel, mode: state.mode },
        { gateway }
      );
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      renderResult();
      if (options.surface === "extension") {
        els.result.scrollIntoView({ block: "nearest" });
      }
    }
  }

  async function runDeepCheck(): Promise<void> {
    const gateway = state.engine?.gateway;
    const report = state.report;
    if (!gateway || !report || state.busy) return;
    state.busy = true;
    state.notice = null;
    renderResult();
    try {
      state.report = await escalateReportToCloud(report, { gateway });
    } catch (error) {
      state.notice = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      renderResult();
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────
  function renderPresets(): void {
    els.presets.innerHTML = DEMO_PRESETS.map(
      (preset) => `
        <button class="chip chip--${preset.category}" data-preset="${esc(preset.id)}" title="${esc(preset.blurb)}">
          <span class="chip__dot" aria-hidden="true"></span>
          <span class="chip__label">${esc(preset.name)}</span>
          <span class="chip__lang">${preset.language.toUpperCase()}</span>
        </button>`
    ).join("");
  }

  function renderEngineArea(): void {
    const engine = state.engine;
    if (!engine) {
      els.engineSlot.innerHTML = `<span class="engine engine--pending"><span class="pulse"></span>starting engine…</span>`;
      return;
    }
    if (engine.mode === "mock") {
      els.engineSlot.innerHTML = `
        <span class="engine engine--mock" title="${esc(engine.reason)}">
          <span class="engine__dot"></span> Demo mode <span class="engine__sep">·</span> local heuristic
        </span>`;
      return;
    }
    const caps = state.capabilities;
    const nano =
      caps?.onDevice === "available"
        ? `<span class="engine__nano is-ready">Nano ready</span>`
        : caps?.onDevice === "downloadable"
          ? `<span class="engine__nano is-download">Nano not downloaded</span>`
          : caps?.onDevice === "downloading"
            ? `<span class="engine__nano is-download">Nano downloading…</span>`
            : "";
    els.engineSlot.innerHTML = `
      <span class="engine engine--live" title="${esc(engine.reason)}">
        <span class="engine__dot"></span> Firebase AI Logic
      </span>
      ${nano}`;
  }

  function renderBanner(): void {
    const engine = state.engine;
    if (!engine) {
      els.banner.hidden = true;
      return;
    }
    if (engine.mode === "firebase") {
      els.banner.hidden = true;
      return;
    }
    els.banner.hidden = false;
    els.bannerTitle.textContent = "Demo mode — Firebase is not configured";
    els.bannerText.textContent = `${engine.reason} The Firebase AI Logic calls (hybrid inference, App Check, gemini-3.5-flash-lite) are wired and will run as soon as .env is filled in.`;
    els.bannerAction.hidden = false;
    els.bannerAction.textContent = "Setup steps";
  }

  function renderResult(): void {
    if (state.busy) {
      els.result.innerHTML = renderBusy(state);
      return;
    }
    if (state.error) {
      els.result.innerHTML = renderError(state.error, state.engine?.mode === "mock");
      return;
    }
    if (state.report) {
      els.result.innerHTML = renderReport(state);
      return;
    }
    els.result.innerHTML =
      (state.notice ? `<div class="notice notice--warn standalone">${esc(state.notice)}</div>` : "") +
      renderIdle(state.engine?.mode ?? null);
  }
}

/* ────────────────────────────── templates ───────────────────────────────── */

function shellTemplate(options: AppOptions): string {
  const extension = options.surface === "extension";
  return `
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="logo" aria-hidden="true">🛡️</div>
        <div class="brand__text">
          <h1>Hybrid Scam Shield</h1>
          <p>3-second scam &amp; phishing triage — on-device first, cloud only when it counts.</p>
        </div>
      </div>
      <div class="topbar__right">
        <div id="engineSlot" class="engine-slot"></div>
        <button class="btn btn--ghost btn--sm" id="howBtn">How it works</button>
      </div>
    </header>

    <div class="banner" id="banner" role="status" hidden>
      <span class="banner__icon" aria-hidden="true">🧪</span>
      <div class="banner__body">
        <strong id="bannerTitle"></strong>
        <span id="bannerText"></span>
      </div>
      <button class="btn btn--ghost btn--sm" id="bannerAction" hidden>Setup</button>
    </div>

    <main class="layout">
      <section class="panel panel--input">
        <div class="panel__head">
          <h2><span class="step">1</span> Message under review</h2>
          <span class="hint">Samples run a scan immediately</span>
        </div>

        <div class="presets" id="presets" role="group" aria-label="Sample messages"></div>

        <label class="sr-only" for="input">Message, SMS, email or link to analyse</label>
        <textarea id="input" spellcheck="false" autocomplete="off"
          placeholder="Paste a suspicious SMS, email body, chat message or link here&#10;&#10;e.g. [KB국민은행] 계좌가 정지되었습니다. http://kb-secure-login.top/verify"></textarea>

        <div class="input__meta">
          <span id="charCount">0 / 12,000</span>
          <span class="dot">·</span>
          <span id="deviceHint">checking the engine…</span>
        </div>

        <div class="controls">
          <label class="select">
            <span class="select__label">Strategy</span>
            <select id="mode">
              <option value="AUTO">Auto — on-device, escalate only if needed</option>
              <option value="ON_DEVICE_ONLY">On-device only — nothing leaves this device</option>
              <option value="CLOUD_ONLY">Cloud only — deepest analysis</option>
            </select>
          </label>
          <div class="controls__buttons">
            <button class="btn btn--ghost" id="clearBtn">Clear</button>
            <button class="btn btn--primary" id="scanBtn">
              <span>Scan message</span>
              <kbd>Ctrl ↵</kbd>
            </button>
          </div>
        </div>

        <div class="capture" id="captureRow" ${extension ? "" : "hidden"}>
          <button class="btn btn--ghost btn--sm" id="captureBtn">Use current tab's selection</button>
          <button class="btn btn--ghost btn--sm" id="sidePanelBtn">Open side panel</button>
        </div>
      </section>

      <section class="panel panel--result" id="result" aria-live="polite"></section>
    </main>

    <footer class="foot">
      <span>Tier 1 runs on this device with Gemini Nano. The message is uploaded only when the escalation policy or you ask for a cloud check.</span>
      <span class="foot__brand">Firebase AI Logic · hybrid inference</span>
    </footer>
  </div>

  <dialog id="howDialog" class="dialog">
    <div class="dialog__head">
      <h2>How Hybrid Scam Shield works</h2>
      <button class="dialog__close" id="dialogClose" aria-label="Close">✕</button>
    </div>
    <div class="dialog__body">
      <h3>1 · On-device triage (default)</h3>
      <p>
        The message is sent to a <code>GenerativeModel</code> created with
        <code>mode: InferenceMode.PREFER_ON_DEVICE</code>. Chrome runs Gemini Nano locally through the
        Prompt API; Firebase AI Logic wraps it, builds the request and reports
        <code>result.response.inferenceSource</code> — which is printed on every verdict card as
        <strong>ON-DEVICE</strong> or <strong>CLOUD</strong>.
      </p>
      <h3>2 · Escalation policy</h3>
      <p>
        The cloud tier runs only when the on-device verdict sets
        <code>needsCloudEscalation: true</code>, when the verdict is DANGEROUS, when confidence falls
        below 60%, or when the on-device model is unavailable. In <em>On-device only</em> mode the cloud
        is never called.
      </p>
      <h3>3 · Deep analysis</h3>
      <p>
        Tier 2 asks <code>gemini-3.5-flash-lite</code> (change with <code>VITE_AI_CLOUD_MODEL</code>) for
        a deeper social-engineering read plus a concrete action checklist. The two verdicts are merged
        so the cloud can never quietly downgrade an on-device alarm.
      </p>
      <h3>Privacy</h3>
      <ul>
        <li>No analytics, no third-party scripts, no message history leaves the page.</li>
        <li>App Check (reCAPTCHA Enterprise) protects the cloud calls; a debug token is used only when <code>VITE_FIREBASE_APP_CHECK_DEBUG=true</code>.</li>
        <li>Demo mode runs a local rule table and is labelled <strong>DEMO MOCK</strong> — never presented as a model verdict.</li>
      </ul>
      <h3>Run it yourself</h3>
      <pre>cp .env.example .env      # fill in the Firebase web app values
npm install
npm run dev               # web demo at http://localhost:5173
npm run build             # dist/ contains the web demo and the extension</pre>
      <h3>Enable Gemini Nano (Chrome 138+)</h3>
      <ol>
        <li>Open <code>chrome://flags/#prompt-api-for-gemini-nano-multimodal-input</code> → Enabled.</li>
        <li>Open <code>chrome://flags/#optimization-guide-on-device-model</code> → Enabled BypassPerfRequirement.</li>
        <li>Restart Chrome, then check <code>chrome://on-device-internals</code> until the model is ready.</li>
      </ol>
      <p class="muted">Without Nano the SDK falls back to the cloud model and the card says so.</p>
    </div>
  </dialog>`;
}

function renderIdle(mode: "firebase" | "mock" | null): string {
  const banner =
    mode === "mock"
      ? `<div class="idle__note">Running the demo heuristic. Add Firebase credentials to switch the very same pipeline to Gemini Nano + gemini-3.5-flash-lite.</div>`
      : "";
  return `
    <div class="idle">
      <div class="idle__art" aria-hidden="true"><span>🛡️</span></div>
      <h2>Three seconds to a verdict</h2>
      <p class="idle__lead">Paste a message, or press a sample to see the hybrid pipeline end to end.</p>
      <ol class="idle__steps">
        <li>
          <span class="idle__num">1</span>
          <div>
            <strong>On-device triage</strong>
            <p>Gemini Nano through Firebase AI Logic, <code>PREFER_ON_DEVICE</code>. The message stays on this device.</p>
          </div>
        </li>
        <li>
          <span class="idle__num">2</span>
          <div>
            <strong>Explainable escalation</strong>
            <p>Cloud only when the verdict is dangerous, unsure, or asks for a deeper look — the reason is shown.</p>
          </div>
        </li>
        <li>
          <span class="idle__num">3</span>
          <div>
            <strong>Proof, not promises</strong>
            <p>Every card carries the real <code>inferenceSource</code>, the model, the latency and the raw JSON.</p>
          </div>
        </li>
      </ol>
      ${banner}
    </div>`;
}

function renderBusy(state: AppState): string {
  const stage =
    state.mode === "ON_DEVICE_ONLY"
      ? "Running on-device triage…"
      : state.mode === "CLOUD_ONLY"
        ? "Running the cloud model…"
        : "Tier 1 · on-device triage…";
  return `
    <div class="busy">
      <div class="busy__spinner" aria-hidden="true"></div>
      <p class="busy__stage">${esc(stage)}</p>
      <div class="busy__pipe" aria-hidden="true">
        <span class="pipe-node is-active">On-device</span>
        <span class="pipe-arrow">→</span>
        <span class="pipe-node">Policy</span>
        <span class="pipe-arrow">→</span>
        <span class="pipe-node">Cloud</span>
      </div>
      <p class="busy__hint">First run may prepare Gemini Nano. Nothing is uploaded in on-device mode.</p>
    </div>`;
}

function renderError(message: string, mock: boolean): string {
  return `
    <div class="error-card">
      <span class="error-card__icon" aria-hidden="true">⚠️</span>
      <div>
        <h2>Scan could not finish</h2>
        <p>${esc(message)}</p>
        ${mock ? `<p class="muted">Demo mode is active. Check the browser console for details.</p>` : ""}
      </div>
    </div>`;
}

function renderReport(state: AppState): string {
  const report = state.report;
  if (!report) return renderIdle(state.engine?.mode ?? null);

  const final = report.final;
  const tone = riskTone(final.riskLevel);
  const decisive = decisiveRun(report);
  const source = decisive?.source ?? "UNKNOWN";
  const sTone = sourceTone(source);
  const deepAvailable =
    state.engine?.mode === "firebase" && Boolean(report.tier1) && !report.tier2;
  const escalation = report.escalation;

  return `
    <article class="verdict verdict--${tone}">
      <header class="verdict__head">
        <div class="verdict__title-wrap">
          <span class="eyebrow">Final verdict</span>
          <h2 class="verdict__title">${riskIcon(final.riskLevel)} ${esc(riskHeadline(final.riskLevel))}</h2>
          <span class="verdict__level level level--${tone}">${esc(final.riskLevel)}</span>
        </div>
        <span class="badge badge--${sTone}" title="${esc(sourceHelp(source))}">
          <span aria-hidden="true">${sourceIcon(source)}</span>${esc(sourceLabel(source))}
        </span>
      </header>

      <div class="meter" role="img" aria-label="Confidence ${percent(final.confidence)}">
        <div class="meter__bar"><span style="width:${Math.round(final.confidence * 100)}%"></span></div>
        <div class="meter__labels">
          <span>Confidence ${percent(final.confidence)}</span>
          <span>${decisive ? `${esc(decisive.model)} · ${formatMs(decisive.latencyMs)}` : ""}</span>
        </div>
      </div>

      ${state.notice ? `<div class="notice notice--warn">${esc(state.notice)}</div>` : ""}

      <p class="summary">${esc(final.summary)}</p>

      ${
        final.signals.length
          ? `<div class="signals">
               <h3>Signals</h3>
               <ul>${final.signals.map((signal) => `<li>${esc(signal)}</li>`).join("")}</ul>
             </div>`
          : ""
      }

      ${
        final.recommendedActions && final.recommendedActions.length
          ? `<div class="actions">
               <h3>Do this now</h3>
               <ol>${final.recommendedActions.map((action) => `<li>${esc(action)}</li>`).join("")}</ol>
             </div>`
          : ""
      }

      ${renderEscalation(escalation, report, state)}

      <div class="tiers">
        <h3>Pipeline</h3>
        ${renderTierRow(report.tier1, 1, "On-device · Gemini Nano")}
        ${renderTierRow(report.tier2, 2, "Cloud · deep analysis")}
        ${renderSkippedRow(report, escalation)}
      </div>

      <details class="raw">
        <summary>Raw report &amp; model output</summary>
        <pre>${esc(JSON.stringify(report, null, 2))}</pre>
      </details>

      <footer class="verdict__foot">
        <button class="btn btn--ghost btn--sm" data-action="copy">${state.copied ? "Copied ✓" : "Copy JSON"}</button>
        <button class="btn btn--ghost btn--sm" data-action="download">Download report</button>
        ${
          deepAvailable
            ? `<button class="btn btn--accent btn--sm" data-action="deep">Deep cloud check</button>`
            : ""
        }
        <span class="verdict__meta">${esc(describeRoute(report.route))} · ${formatMs(report.totalLatencyMs)} total</span>
      </footer>
    </article>`;
}

function renderEscalation(
  escalation: HybridTriageReport["escalation"],
  report: HybridTriageReport,
  state: AppState
): string {
  if (escalation) {
    const label = escalationLabel(escalation.reason);
    return `
      <div class="escalation escalation--${escalation.automatic ? "auto" : "user"}">
        <span class="escalation__badge">${esc(label)}</span>
        <span class="escalation__text">${esc(escalation.detail)}</span>
      </div>`;
  }
  if (report.tier1 && !report.tier2 && report.tier1.source === "ON_DEVICE") {
    return `
      <div class="escalation escalation--stay">
        <span class="escalation__badge">Stayed on device</span>
        <span class="escalation__text">The on-device verdict was confident enough, so the message was never uploaded.</span>
      </div>`;
  }
  if (report.tier1 && !report.tier2 && report.tier1.source === "IN_CLOUD") {
    return `
      <div class="escalation escalation--stay">
        <span class="escalation__badge">Cloud fallback</span>
        <span class="escalation__text">Gemini Nano was not available, so the SDK answered in the cloud instead. Install the on-device model to keep messages local.</span>
      </div>`;
  }
  if (state.engine?.mode === "mock") {
    return `
      <div class="escalation escalation--stay">
        <span class="escalation__badge">Demo</span>
        <span class="escalation__text">Local heuristic only — no model call was made.</span>
      </div>`;
  }
  return "";
}

function renderTierRow(run: TierRun | null, index: number, label: string): string {
  if (!run) return "";
  const tone = riskTone(run.result.riskLevel);
  return `
    <div class="tier tier--done">
      <span class="tier__num">${index}</span>
      <div class="tier__body">
        <strong>${esc(label)}</strong>
        <span class="tier__meta">${esc(run.model)} · ${formatMs(run.latencyMs)}</span>
      </div>
      <span class="level level--${tone} level--sm">${esc(run.result.riskLevel)}</span>
      <span class="badge badge--${sourceTone(run.source)} badge--sm">${esc(sourceLabel(run.source))}</span>
      <span class="tier__conf">${formatPercent(run.result.confidence)}</span>
    </div>`;
}

function renderSkippedRow(report: HybridTriageReport, escalation: HybridTriageReport["escalation"]): string {
  if (report.tier2) return "";
  if (escalation && escalation.reason !== "USER_REQUESTED") return "";
  const reason =
    report.tier1?.source === "IN_CLOUD"
      ? "Tier 2 skipped — the cloud model already produced this verdict."
      : report.route === "MOCK_ONLY"
        ? "Tier 2 unavailable — add Firebase credentials to enable the cloud model."
        : "Tier 2 skipped — the on-device verdict was confident enough.";
  return `
    <div class="tier tier--skipped">
      <span class="tier__num">2</span>
      <div class="tier__body"><strong>Cloud · deep analysis</strong><span class="tier__meta">${esc(reason)}</span></div>
      <span class="tier__conf">not called</span>
    </div>`;
}

function escalationLabel(reason: NonNullable<HybridTriageReport["escalation"]>["reason"]): string {
  switch (reason) {
    case "MODEL_REQUESTED":
      return "Escalated · model asked";
    case "RISK_LEVEL_HIGH":
      return "Escalated · dangerous";
    case "CONFIDENCE_BELOW_FLOOR":
      return "Escalated · low confidence";
    case "ON_DEVICE_UNAVAILABLE":
      return "Escalated · no on-device model";
    case "TIER1_FAILED":
      return "Fallback · on-device failed";
    case "USER_REQUESTED":
      return "Deep cloud check";
    default:
      return "Escalated";
  }
}

function decisiveRun(report: HybridTriageReport): TierRun | null {
  const { tier1, tier2 } = report;
  if (!tier2) return tier1;
  if (!tier1) return tier2;
  const cloudWins = severityOf(tier2.result.riskLevel) >= severityOf(tier1.result.riskLevel);
  return cloudWins ? tier2 : tier1;
}

function detectChannel(text: string): string {
  const trimmed = text.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return "url";
  if (/^\[?(web|sms|mms)?\s*발신\]?/i.test(trimmed) || /^\[[A-Za-z0-9 .&-]{2,20}\]/.test(trimmed)) return "sms";
  if (/https?:\/\//i.test(trimmed)) return "link";
  return "unknown";
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

export { riskTone, sourceTone };
