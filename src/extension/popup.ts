/**
 * Extension entry point — shared by the toolbar popup and the side panel.
 *
 * Both surfaces need the same three browser capabilities:
 *   1. read the active tab's selection / visible text (`chrome.scripting`);
 *   2. pick up a scan started from the context menu (`chrome.storage.session`);
 *   3. open the side panel for a wider view.
 */

import { mountApp } from "../ui/app";

interface PendingScan {
  text: string;
  url?: string;
  at?: number;
}

async function main(): Promise<void> {
  document.body.classList.add("surface-extension");
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app root element");

  const pending = await consumePendingScan();

  mountApp(root, {
    surface: "extension",
    initialText: pending?.text ?? "",
    autoScan: Boolean(pending?.text),
    capturePageText,
    openSidePanel
  });
}

async function consumePendingScan(): Promise<PendingScan | null> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: "pending-scan-consume" })) as
      | { pendingScan?: PendingScan | null }
      | undefined;
    return response?.pendingScan ?? null;
  } catch {
    return null;
  }
}

interface CaptureResult {
  text: string;
  kind: "selection" | "page";
}

async function capturePageText(): Promise<{ text: string; kind: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab to read.");

  if (tab.url && !/^https?:/i.test(tab.url)) {
    throw new Error(
      "Chrome does not let extensions read this page (browser pages, the Web Store, or another extension). Open the suspicious message in a normal tab."
    );
  }

  let results: Array<{ result?: CaptureResult }>;
  try {
    results = (await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const selection = (window.getSelection()?.toString() ?? "").trim();
        const text = selection.length > 0 ? selection : document.body?.innerText ?? "";
        return {
          text: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000),
          kind: selection.length > 0 ? "selection" : "page"
        } as CaptureResult;
      }
    })) as Array<{ result?: CaptureResult }>;
  } catch (error) {
    throw new Error(
      `Could not read this tab (${error instanceof Error ? error.message : String(error)}). Try selecting the text and using the right-click menu instead.`
    );
  }

  const captured = results[0]?.result;
  if (!captured || captured.text.length === 0) {
    throw new Error("This page has no readable text. Select the message text, then try again.");
  }
  return { text: captured.text, kind: captured.kind };
}

async function openSidePanel(): Promise<void> {
  try {
    const win = await chrome.windows.getCurrent();
    if (win.id === undefined) return;
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  } catch (error) {
    console.warn("[scam-shield] could not open the side panel:", error);
  }
}

void main();
