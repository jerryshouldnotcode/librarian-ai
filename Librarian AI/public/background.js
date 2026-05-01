// redirects pdf links to the viewer page instead of native pdf viewer

async function registerPdfRedirectRule() {
  const extId = chrome.runtime.id;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
            redirect: {
              regexSubstitution: `chrome-extension://${extId}/viewer.html#\\1`,
            },
          },
          condition: {
            regexFilter: '^((https?://.+\\.pdf([?].*)?)|(file://.*\\.pdf)|(https?://arxiv.org/pdf/.*))$',
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
          },
        },
      ],
    });
  } catch (err) {
    console.error('[Librarian AI] declarativeNetRequest.updateDynamicRules failed', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void registerPdfRedirectRule();
});

void registerPdfRedirectRule();

/**
 * OpenAI chat completions (viewer page sends key from chrome.storage.local).
 * @param {{ apiKey: string, model: string, prompt: string, context: string }} payload
 */
async function openaiChat(payload) {
  const { apiKey, model, prompt, context } = payload ?? {};
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("Missing API key");
  }
  if (!prompt || typeof prompt !== "string") {
    throw new Error("Missing prompt");
  }

  const userContent = [
    "Context (from PDF selection; may be empty):",
    context && context.trim() ? context.trim() : "(none)",
    "",
    "Question:",
    prompt.trim(),
  ].join("\n");

  const body = {
    model: typeof model === "string" && model ? model : "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are Librarian AI, helping the user read an academic PDF. Answer using the provided context when it helps; if context is missing or irrelevant, answer from general knowledge and say so briefly.",
      },
      { role: "user", content: userContent },
    ],
    temperature: 0.4,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(`OpenAI response was not JSON (HTTP ${response.status})`);
  }

  if (!response.ok) {
    const msg = data?.error?.message ?? rawText.slice(0, 200) ?? `HTTP ${response.status}`;
    throw new Error(msg);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("OpenAI returned no message content");
  }

  return { content };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPENAI_CHAT") {
    void openaiChat(message.payload)
      .then((result) => {
        sendResponse({ ok: true, content: result.content });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true;
  }
  return false;
});
