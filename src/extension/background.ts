/**
 * MV3 service worker.
 *
 * Responsibilities:
 *  - register the "Scan selection" context menu;
 *  - stash the selected text in `chrome.storage.session` (never on disk);
 *  - open the side panel so the scan UI appears next to the page.
 *
 * No network calls happen here: inference runs in the popup/side-panel page so
 * the on-device Prompt API can be used from a normal document context.
 */

const CONTEXT_MENU_ID = "scam-shield-scan-selection";

interface PendingScan {
  text: string;
  url: string;
  at: number;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Scan with Hybrid Scam Shield",
      contexts: ["selection"]
    });
  });
  void setPanelBehaviour();
});

void setPanelBehaviour();

async function setPanelBehaviour(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (error) {
    console.warn("[scam-shield] side panel behaviour unavailable:", error);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const text = (info.selectionText ?? "").trim();
  if (text.length === 0) return;

  const pending: PendingScan = { text, url: tab?.url ?? "", at: Date.now() };
  void chrome.storage.session.set({ pendingScan: pending }).then(async () => {
    if (tab?.windowId === undefined) return;
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (error) {
      console.warn("[scam-shield] could not open the side panel:", error);
    }
  });
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const type = (message as { type?: string } | null)?.type;

  if (type === "pending-scan-consume") {
    void chrome.storage.session.get("pendingScan").then((value) => {
      const pending = value.pendingScan as PendingScan | undefined;
      void chrome.storage.session.remove("pendingScan");
      sendResponse({ pendingScan: pending ?? null });
    });
    return true; // keep the message channel open for the async response
  }

  if (type === "open-side-panel") {
    void chrome.windows.getCurrent().then(async (win) => {
      if (win.id === undefined) {
        sendResponse({ ok: false, error: "No window id" });
        return;
      }
      try {
        await chrome.sidePanel.open({ windowId: win.id });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
    });
    return true;
  }

  return false;
});
