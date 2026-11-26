// @vitest-environment jsdom
/**
 * UI smoke tests.
 *
 * They mount the real app in jsdom with the demo gateway (no Firebase config in
 * the test environment), drive it through the actual DOM the user clicks, and
 * assert the card renders the things the product promises: risk verdict, the
 * inference-source badge, signals, the pipeline and the raw JSON.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mountApp } from "../src/ui/app";
import { DEMO_PRESETS } from "../src/core/presets";

function setupRoot(): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById("app");
  if (!root) throw new Error("root missing");
  return root;
}

async function waitFor<T>(predicate: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // Poll with timers so the promise chain of the scan can settle.
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the UI to settle");
}

async function mountWeb(): Promise<HTMLElement> {
  const root = setupRoot();
  mountApp(root, { surface: "web" });
  await waitFor(() => root.querySelector(".engine--mock"));
  return root;
}

let roots: HTMLElement[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const root of roots) root.innerHTML = "";
  document.body.innerHTML = "";
});

describe("mountApp (web, demo engine)", () => {
  it("renders one chip per preset and the idle explainer", async () => {
    const root = await mountWeb();
    roots.push(root);

    expect(root.querySelectorAll("[data-preset]")).toHaveLength(DEMO_PRESETS.length);
    const result = root.querySelector("#result");
    expect(result?.textContent).toContain("Three seconds to a verdict");
  });

  it("shows the demo-mode banner when Firebase is not configured", async () => {
    const root = await mountWeb();
    roots.push(root);

    const banner = root.querySelector("#banner") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("Firebase is not configured");
  });

  it("scans a scam preset and renders a DANGEROUS verdict with the source badge", async () => {
    const root = await mountWeb();
    roots.push(root);

    const chip = root.querySelector<HTMLElement>('[data-preset="en-ceo-giftcard"]');
    expect(chip).not.toBeNull();
    chip?.click();

    const card = await waitFor(() => root.querySelector(".verdict"));
    expect(card.className).toContain("verdict--danger");
    expect(card.textContent).toContain("Likely a scam");
    expect(card.textContent).toContain("DEMO MOCK");
    expect(card.textContent).toContain("DANGEROUS");
    expect(card.textContent).toContain("Do this now");
    expect(card.textContent).toContain("Local heuristic only");
    expect(card.textContent).toContain("local-heuristic-v1");
    expect(root.querySelector(".raw pre")?.textContent).toContain('"riskLevel": "DANGEROUS"');
  });

  it("classifies a safe preset as SAFE", async () => {
    const root = await mountWeb();
    roots.push(root);

    root.querySelector<HTMLElement>('[data-preset="en-safe-coworker"]')?.click();
    const card = await waitFor(() => root.querySelector(".verdict"));
    expect(card.className).toContain("verdict--safe");
    expect(card.textContent).toContain("SAFE");
  });

  it("rejects input that is too short with a readable message", async () => {
    const root = await mountWeb();
    roots.push(root);

    const input = root.querySelector<HTMLTextAreaElement>("#input");
    if (!input) throw new Error("input missing");
    input.value = "hi";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("#scanBtn")?.click();

    const card = await waitFor(() => root.querySelector(".error-card"));
    expect(card.textContent).toContain("too short");
  });

  it("clears the result and the textarea", async () => {
    const root = await mountWeb();
    roots.push(root);

    root.querySelector<HTMLElement>('[data-preset="en-safe-order"]')?.click();
    await waitFor(() => root.querySelector(".verdict"));

    root.querySelector<HTMLButtonElement>("#clearBtn")?.click();
    expect(root.querySelector(".verdict")).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>("#input")?.value).toBe("");
  });
});
