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
            regexFilter: '^(https?://.+\\.pdf([?#].*)?|file://.*\\.pdf|https?://arxiv.org/pdf/.*)$',
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
