/**
 * Librarian AI — chat provider (OpenAI) for the extension viewer page.
 * Sidebar UI stays in sidebar.mjs; this module owns transport + storage signals.
 *
 * Events:
 * - document "librarian:ai:ready"  detail: { configured: boolean }
 * - document "librarian:ai:request" detail: { requestId, prompt, context? }
 * - document "librarian:ai:response" detail: { requestId, content }
 * - document "librarian:ai:error"   detail: { requestId, message }
 */

const OPENAI_API_KEY_STORAGE_KEY = "librarianOpenaiApiKey";
const CHAT_MODEL = "gpt-4o-mini";

function dispatch(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

async function getStoredApiKey() {
  try {
    const result = await chrome.storage.local.get([OPENAI_API_KEY_STORAGE_KEY]);
    const key = result?.[OPENAI_API_KEY_STORAGE_KEY];
    return typeof key === "string" ? key : "";
  } catch {
    return "";
  }
}

async function publishReady() {
  const key = await getStoredApiKey();
  dispatch("librarian:ai:ready", { configured: Boolean(key.trim()) });
}

async function handleAiRequest(event) {
  const detail = event?.detail ?? {};
  const requestId = typeof detail.requestId === "string" ? detail.requestId : "";
  const prompt = typeof detail.prompt === "string" ? detail.prompt.trim() : "";
  const context = typeof detail.context === "string" ? detail.context : "";

  if (!requestId || !prompt) {
    return;
  }

  const apiKey = (await getStoredApiKey()).trim();
  if (!apiKey) {
    dispatch("librarian:ai:error", {
      requestId,
      message:
        "No OpenAI API key stored. Set chrome.storage.local key librarianOpenaiApiKey (or use window.librarianAI.setApiKey from the devtools console for now).",
    });
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "OPENAI_CHAT",
      payload: {
        apiKey,
        model: CHAT_MODEL,
        prompt,
        context,
      },
    });

    if (!res?.ok) {
      throw new Error(res?.error || "Chat request failed");
    }

    const content = typeof res.content === "string" ? res.content : "";
    dispatch("librarian:ai:response", { requestId, content });
  } catch (error) {
    dispatch("librarian:ai:error", {
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

document.addEventListener("librarian:ai:request", (event) => {
  void handleAiRequest(event);
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.prototype.hasOwnProperty.call(changes, OPENAI_API_KEY_STORAGE_KEY)) {
      void publishReady();
    }
  });
} catch {
  // ignore
}

window.librarianAI = {
  OPENAI_API_KEY_STORAGE_KEY,
  async isConfigured() {
    return Boolean((await getStoredApiKey()).trim());
  },
  async setApiKey(key) {
    const trimmed = typeof key === "string" ? key.trim() : "";
    await chrome.storage.local.set({ [OPENAI_API_KEY_STORAGE_KEY]: trimmed });
    await publishReady();
  },
  async clearApiKey() {
    await chrome.storage.local.remove([OPENAI_API_KEY_STORAGE_KEY]);
    await publishReady();
  },
  refreshStatus: publishReady,
};

void publishReady();
