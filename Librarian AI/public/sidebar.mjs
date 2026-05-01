const sidebarEl = document.getElementById("sidebar");
const toggleEl = document.getElementById("sidebarToggle");
const rootEl = document.documentElement;

const OPEN_WIDTH = "22rem";
const CLOSED_WIDTH = "0px";
const TAB_ORDER = ["chat", "highlights", "notes"];

const state = {
  isOpen: true,
  activeTab: "chat",
  documentUrl: "",
  pagesCount: 0,
  selectedText: "",
  selectedPageNumbers: [],
  selectedHighlightId: null,
  chatContextHighlightId: null,
  highlightColor: "yellow",
  highlightMenu: null,
  expandedHighlightIds: new Set(),
  draftMessage: "",
  messages: [],
  noteDrafts: new Map(),
  /** OpenAI key present (see public/ai.mjs + background.js). */
  chatAiConfigured: false,
  chatAiSending: false,
  pendingAiRequestId: null,
};

let saveNotesTimer = null;

bootSidebar();

function bootSidebar() {
  if (!sidebarEl || !toggleEl) {
    return;
  }

  injectStyles();
  syncSidebarWidth();
  wireEvents();
  hydrateFromViewer();
  render();
}

function wireEvents() {
  toggleEl.addEventListener("click", () => toggleSidebar());

  document.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) {
      return;
    }

    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        toggleSidebar();
      }
    }
  });

  document.addEventListener("librarian:documentloaded", onDocumentLoaded);
  document.addEventListener("librarian:selectioncaptured", onSelectionCaptured);
  document.addEventListener("librarian:highlightschanged", onHighlightsChanged);
  document.addEventListener("librarian:viewer:highlight-selected", onViewerHighlightSelected);
  document.addEventListener("librarian:viewer:highlight-contextmenu", onViewerHighlightContextMenu);
  document.addEventListener("librarian:ai:ready", onAiReady);
  document.addEventListener("librarian:ai:response", onAiResponse);
  document.addEventListener("librarian:ai:error", onAiError);

  sidebarEl.addEventListener("click", onSidebarClick);
  sidebarEl.addEventListener("contextmenu", onSidebarContextMenu);
  sidebarEl.addEventListener("submit", onSidebarSubmit);
  sidebarEl.addEventListener("input", onSidebarInput);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);
}

function hydrateFromViewer() {
  const viewer = window.librarianViewer;
  if (Array.isArray(viewer?.highlights)) {
    state.selectedHighlightId = viewer.highlights[0]?.id ?? null;
  }
  state.highlightColor = getViewerHighlightColor();
}

async function loadDocumentState(documentUrl) {
  if (!documentUrl) {
    return false;
  }

  const blob = await storageGet(notesStorageKey(documentUrl));
  const noteDrafts = blob?.noteDrafts;
  state.noteDrafts.clear();

  if (noteDrafts && typeof noteDrafts === "object" && !Array.isArray(noteDrafts)) {
    for (const [highlightId, value] of Object.entries(noteDrafts)) {
      if (typeof highlightId === "string" && typeof value === "string") {
        state.noteDrafts.set(highlightId, value);
      }
    }
  }

  return true;
}

function onDocumentLoaded(event) {
  const detail = event?.detail ?? {};
  const nextUrl = typeof detail.url === "string" ? detail.url : "";

  if (nextUrl && nextUrl !== state.documentUrl) {
    state.documentUrl = nextUrl;
    state.pagesCount = Number.isFinite(detail.pagesCount) ? detail.pagesCount : 0;
    state.selectedText = "";
    state.selectedPageNumbers = [];
    state.selectedHighlightId = null;
    state.chatContextHighlightId = null;
    state.expandedHighlightIds.clear();
    state.draftMessage = "";
    state.messages = [];
    state.noteDrafts.clear();
    state.chatAiSending = false;
    state.pendingAiRequestId = null;
    void loadDocumentState(nextUrl).then((loaded) => {
      if (loaded && state.documentUrl === nextUrl) {
        render();
      }
    });
    return;
  }

  if (Number.isFinite(detail.pagesCount)) {
    state.pagesCount = detail.pagesCount;
    render();
  }
}

function onSelectionCaptured(event) {
  const detail = event?.detail ?? {};
  state.selectedText = typeof detail.selectedText === "string" ? detail.selectedText : "";
  state.selectedPageNumbers = Array.isArray(detail.pageNumbers) ? detail.pageNumbers : [];

  if (state.selectedText && state.activeTab === "chat") {
    render();
    return;
  }

  if (!state.selectedText && state.activeTab === "chat") {
    render();
    return;
  }

  render();
}

function onHighlightsChanged() {
  const viewer = window.librarianViewer;
  const highlights = Array.isArray(viewer?.highlights) ? viewer.highlights : [];
  if (!state.selectedHighlightId && highlights.length) {
    state.selectedHighlightId = highlights[0].id;
  } else if (state.selectedHighlightId && !highlights.some((item) => item.id === state.selectedHighlightId)) {
    state.selectedHighlightId = highlights[0]?.id ?? null;
  }

  if (state.chatContextHighlightId && !highlights.some((item) => item.id === state.chatContextHighlightId)) {
    state.chatContextHighlightId = null;
  }

  render();
}

function onAiReady(event) {
  state.chatAiConfigured = Boolean(event?.detail?.configured);
  render();
}

function onAiResponse(event) {
  const detail = event?.detail ?? {};
  const requestId = typeof detail.requestId === "string" ? detail.requestId : "";
  const content = typeof detail.content === "string" ? detail.content : "";
  if (!requestId || requestId !== state.pendingAiRequestId) {
    return;
  }

  state.chatAiSending = false;
  state.pendingAiRequestId = null;
  state.messages = [
    ...state.messages,
    {
      role: "assistant",
      content,
      timestamp: Date.now(),
    },
  ];
  render();
}

function onAiError(event) {
  const detail = event?.detail ?? {};
  const requestId = typeof detail.requestId === "string" ? detail.requestId : "";
  const message = typeof detail.message === "string" ? detail.message : "Request failed";
  if (!requestId || requestId !== state.pendingAiRequestId) {
    return;
  }

  state.chatAiSending = false;
  state.pendingAiRequestId = null;
  state.messages = [
    ...state.messages,
    {
      role: "assistant",
      content: `Error: ${message}`,
      timestamp: Date.now(),
    },
  ];
  render();
}

function onSidebarClick(event) {
  const actionEl = event.target.closest?.("[data-action]");
  if (!actionEl) {
    if (!event.target.closest?.(".sidebarHighlightMenu")) {
      closeHighlightMenu();
    }
    return;
  }

  const action = actionEl.dataset.action;
  if (action === "set-tab") {
    event.preventDefault();
    setActiveTab(actionEl.dataset.tab ?? "chat");
    return;
  }

  if (action === "set-highlight-color") {
    event.preventDefault();
    const color = actionEl.dataset.color ?? "yellow";
    setHighlightColor(color, {
      highlightId: actionEl.dataset.highlightId ?? state.highlightMenu?.highlightId ?? "",
      groupId: actionEl.dataset.groupId ?? state.highlightMenu?.groupId ?? "",
    });
    return;
  }

  if (action === "focus-highlight") {
    event.preventDefault();
    const pageNumber = Number(actionEl.dataset.pageNumber);
    const highlightId = actionEl.dataset.highlightId ?? "";
    if (Number.isFinite(pageNumber)) {
      state.selectedHighlightId = highlightId;
      dispatchFocusHighlight(pageNumber, highlightId);
      render();
    }
    return;
  }

  if (action === "toggle-highlight-expand") {
    event.preventDefault();
    const highlightId = actionEl.dataset.highlightId ?? "";
    if (highlightId) {
      if (state.expandedHighlightIds.has(highlightId)) {
        state.expandedHighlightIds.delete(highlightId);
      } else {
        state.expandedHighlightIds.add(highlightId);
      }
      render();
    }
    return;
  }

  if (action === "use-selected-context") {
    event.preventDefault();
    if (!state.selectedHighlightId) {
      return;
    }
    state.chatContextHighlightId = state.selectedHighlightId;
    state.activeTab = "chat";
    render();
    return;
  }

  if (action === "delete-highlight") {
    event.preventDefault();
    const highlightId = actionEl.dataset.highlightId ?? "";
    const groupId = actionEl.dataset.groupId ?? "";
    if (highlightId || groupId) {
      document.dispatchEvent(
        new CustomEvent("librarian:sidebar:delete-highlight", {
          detail: { highlightId, groupId },
        }),
      );
    }
    closeHighlightMenu();
    return;
  }

  if (action === "close-highlight-menu") {
    event.preventDefault();
    closeHighlightMenu();
  }
}

function onSidebarContextMenu(event) {
  const highlightEl = event.target.closest?.("[data-highlight-id]");
  if (!(highlightEl instanceof HTMLElement)) {
    closeHighlightMenu();
    return;
  }

  const highlightId = highlightEl.dataset.highlightId ?? "";
  const groupId = highlightEl.dataset.groupId ?? "";
  if (!highlightId) {
    return;
  }

  event.preventDefault();
  openHighlightMenu({
    highlightId,
    groupId,
    x: event.clientX,
    y: event.clientY,
  });
}

function onDocumentClick(event) {
  if (!state.highlightMenu) {
    return;
  }

  if (sidebarEl.contains(event.target) && event.target.closest?.(".sidebarHighlightMenu")) {
    return;
  }

  if (sidebarEl.contains(event.target) && event.target.closest?.("[data-highlight-id]")) {
    return;
  }

  closeHighlightMenu();
}

function onDocumentKeydown(event) {
  if (event.key === "Escape" && state.highlightMenu) {
    closeHighlightMenu();
  }
}

function onViewerHighlightSelected(event) {
  const detail = event?.detail ?? {};
  const highlightId = typeof detail.highlightId === "string" ? detail.highlightId : "";
  if (!highlightId) {
    return;
  }

  state.selectedHighlightId = highlightId;
  closeHighlightMenu(false);
  render();
}

function onViewerHighlightContextMenu(event) {
  const detail = event?.detail ?? {};
  const highlightId = typeof detail.highlightId === "string" ? detail.highlightId : "";
  if (!highlightId) {
    return;
  }

  state.selectedHighlightId = highlightId;
  openHighlightMenu({
    highlightId,
    groupId: typeof detail.groupId === "string" ? detail.groupId : "",
    x: Number.isFinite(detail.clientX) ? detail.clientX : window.innerWidth / 2,
    y: Number.isFinite(detail.clientY) ? detail.clientY : window.innerHeight / 2,
  });
}

function closeHighlightMenu(shouldRender = true) {
  if (!state.highlightMenu) {
    return;
  }

  state.highlightMenu = null;
  if (shouldRender) {
    render();
  }
}

function openHighlightMenu(menuState) {
  state.highlightMenu = menuState;
  if (!state.isOpen) {
    state.isOpen = true;
    syncSidebarWidth();
  }
  render();
}

function onSidebarSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  if (form.dataset.role === "chat-composer") {
    event.preventDefault();
    if (!state.chatAiConfigured || state.chatAiSending) {
      return;
    }
    const input = form.querySelector('textarea[name="chatPrompt"]');
    const text = typeof input?.value === "string" ? input.value.trim() : "";
    if (!text) {
      return;
    }

    const requestId = crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    state.pendingAiRequestId = requestId;
    state.chatAiSending = true;
    state.messages = [
      ...state.messages,
      {
        role: "user",
        content: text,
        timestamp: Date.now(),
      },
    ];
    state.draftMessage = "";
    render();

    document.dispatchEvent(
      new CustomEvent("librarian:ai:request", {
        detail: {
          requestId,
          prompt: text,
          context: buildChatContext(),
        },
      }),
    );
    return;
  }
}

function onSidebarInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) {
    return;
  }

  if (target.name === "chatPrompt") {
    state.draftMessage = target.value;
    return;
  }

  if (target.name === "noteDraft") {
    const highlightId = target.dataset.highlightId ?? "";
    if (highlightId) {
      state.noteDrafts.set(highlightId, target.value);
      scheduleSaveNotes();
    }
  }
}

function toggleSidebar(forceOpen = null) {
  state.isOpen = typeof forceOpen === "boolean" ? forceOpen : !state.isOpen;
  syncSidebarWidth();
  render();
}

function setActiveTab(tab) {
  if (!TAB_ORDER.includes(tab)) {
    return;
  }
  state.activeTab = tab;
  render();
}

function dispatchFocusHighlight(pageNumber, highlightId) {
  document.dispatchEvent(
    new CustomEvent("librarian:sidebar:focus-highlight", {
      detail: { pageNumber, highlightId },
    }),
  );
}

function buildChatContext() {
  const viewer = window.librarianViewer;
  const highlights = Array.isArray(viewer?.highlights) ? viewer.highlights : [];
  const selectedHighlight = state.chatContextHighlightId
    ? highlights.find((item) => item.id === state.chatContextHighlightId) ?? null
    : null;

  const parts = [];
  if (selectedHighlight) {
    parts.push(`Highlight on page ${selectedHighlight.pageNumber ?? "?"}: ${selectedHighlight.exact}`);
    if (selectedHighlight.prefix || selectedHighlight.suffix) {
      const contextPieces = [selectedHighlight.prefix, selectedHighlight.exact, selectedHighlight.suffix].filter(Boolean);
      parts.push(`Surrounding context: ${contextPieces.join("")}`);
    }
  } else if (state.selectedText) {
    parts.push(state.selectedText);
  }

  return parts.join("\n\n");
}

function syncSidebarWidth() {
  rootEl.style.setProperty("--sidebar-width", state.isOpen ? OPEN_WIDTH : CLOSED_WIDTH);
  sidebarEl.hidden = !state.isOpen;
  toggleEl.textContent = state.isOpen ? "Hide sidebar" : "Show sidebar";
}

function render() {
  const renderState = captureRenderState();
  syncSidebarWidth();

  const viewer = window.librarianViewer;
  const highlights = Array.isArray(viewer?.highlights) ? viewer.highlights : [];
  const contextText = truncateText(buildChatContext() || state.selectedText || "", 220);
  const highlightColor = getViewerHighlightColor();
  state.highlightColor = highlightColor;
  const notesHint = state.documentUrl
    ? "Notes save locally for this document."
    : "Open a PDF to start taking notes.";

  sidebarEl.innerHTML = `
    <div class="sidebarShell">
      <header class="sidebarHeader">
        <div>
          <div class="sidebarEyebrow">Document</div>
          <h2 class="sidebarTitle">Context</h2>
        </div>
      </header>

      <section class="sidebarStatusCard ${state.chatAiConfigured ? "is-connected" : "is-offline"}" aria-live="polite">
        <div class="sidebarStatusLabel">Chat</div>
        <div class="sidebarStatusText">${
          state.chatAiConfigured
            ? state.chatAiSending
              ? "Waiting for response..."
              : "Connected"
            : "Offline / not connected"
        }</div>
        <div class="sidebarStatusMeta">${
          state.chatAiConfigured
            ? "OpenAI key found. Messages go through the extension background worker."
            : "Set storage key librarianOpenaiApiKey (e.g. await librarianAI.setApiKey('sk-?') in the viewer console) or wire a settings UI."
        }</div>
      </section>

      <section class="sidebarSummary">
        <div class="sidebarSummaryStat">
          <span class="sidebarSummaryLabel">Pages</span>
          <strong>${state.pagesCount || "?"}</strong>
        </div>
        <div class="sidebarSummaryStat">
          <span class="sidebarSummaryLabel">Highlights</span>
          <strong>${highlights.length}</strong>
        </div>
        <div class="sidebarSummaryStat">
          <span class="sidebarSummaryLabel">Selection</span>
          <strong>${state.selectedText ? "Active" : "None"}</strong>
        </div>
      </section>

      <nav class="sidebarTabs" aria-label="Sidebar views">
        ${TAB_ORDER.map((tab) => {
          return `
          <button
            type="button"
            class="sidebarTab${state.activeTab === tab ? " is-active" : ""}"
            data-action="set-tab"
            data-tab="${tab}"
          >
            ${tab}
          </button>
          `;
        }).join("")}
      </nav>

      <main class="sidebarBody">
        ${renderActiveTab(highlights, contextText, notesHint)}
      </main>
      ${renderHighlightMenu(highlights)}
    </div>
  `;

  const chatText = sidebarEl.querySelector('textarea[name="chatPrompt"]');
  if (chatText) {
    chatText.value = state.draftMessage;
  }

  const noteText = sidebarEl.querySelector('textarea[name="noteDraft"]');
  const selectedHighlight = highlights.find((item) => item.id === state.selectedHighlightId) ?? null;
  if (noteText) {
    const draft = state.selectedHighlightId ? state.noteDrafts.get(state.selectedHighlightId) ?? "" : "";
    noteText.value = draft;
    noteText.placeholder = selectedHighlight ? "Write a note for this highlight" : "Select a highlight first";
  }

  restoreRenderState(renderState);
}

function renderActiveTab(highlights, contextText, notesHint) {
  if (state.activeTab === "highlights") {
    return renderHighlightsTab(highlights);
  }

  if (state.activeTab === "notes") {
    return renderNotesTab(highlights, notesHint);
  }

  return renderChatTab(highlights, contextText);
}

function renderChatTab(highlights, contextText) {
  const chatInputEnabled = state.chatAiConfigured && !state.chatAiSending;
  const chatPlaceholder = !state.chatAiConfigured
    ? "Chat offline: set OpenAI API key (see status card)."
    : state.chatAiSending
      ? "Waiting for response..."
      : "Ask about the paper";

  return `
    <section class="sidebarSection">
      <div class="sidebarSectionHeader">
        <h3>Chat</h3>
        <span>${state.messages.length ? `${state.messages.length} message${state.messages.length === 1 ? "" : "s"}` : "Empty thread"}</span>
      </div>

      <div class="sidebarThreadCard">
        <div class="sidebarThreadHeader">
          <div class="sidebarContextLabel">Thread context</div>
          <div class="sidebarThreadPill">${
            state.chatContextHighlightId
              ? "Selected highlight"
              : state.chatAiConfigured
                ? state.chatAiSending
                  ? "Sending"
                  : "Ready"
                : "Offline"
          }</div>
        </div>
        <div class="sidebarContextText">${contextText ? escapeHtml(contextText) : "Select text in the PDF to seed chat context."}</div>
      </div>

      <div class="sidebarMessageList" role="log" aria-live="polite">
        ${state.messages.length
          ? state.messages.map(renderMessage).join("")
          : `<div class="sidebarEmptyState">${
              state.chatAiConfigured
                ? "No messages yet. Ask a question about the current PDF."
                : "Chat is offline until an API key is configured (ai.mjs + storage)."
            }</div>`}
      </div>

      <form class="sidebarComposer" data-role="chat-composer">
        <textarea
          name="chatPrompt"
          rows="4"
          placeholder="${escapeAttribute(chatPlaceholder)}"
          ${chatInputEnabled ? "" : "readonly"}
          spellcheck="true"
        ></textarea>
        <div class="sidebarComposerActions">
          <button type="submit" ${chatInputEnabled ? "" : "disabled"}>Send</button>
          <button type="button" data-action="set-tab" data-tab="highlights">View highlights</button>
        </div>
      </form>

      <div class="sidebarHint">${highlights.length ? "Recent highlights live in the highlights tab." : "Highlights appear after you select text."}</div>
    </section>
  `;
}

function renderHighlightsTab(highlights) {
  if (!highlights.length) {
    return `
      <section class="sidebarSection">
        <div class="sidebarEmptyState">
          <div class="sidebarEmptyTitle">No highlights yet</div>
          <div class="sidebarEmptyBody">Select text in the PDF to create one. Right-click a highlight later to recolor or delete it.</div>
        </div>
      </section>
    `;
  }

  const grouped = new Map();
  for (const highlight of highlights) {
    const key = Number.isFinite(highlight.pageNumber) ? String(highlight.pageNumber) : "unknown";
    const items = grouped.get(key) ?? [];
    items.push(highlight);
    grouped.set(key, items);
  }

  const sections = [...grouped.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([pageNumber, items]) => `
      <article class="sidebarHighlightGroup">
        <div class="sidebarHighlightGroupHeader">
          <h3>Page ${escapeHtml(pageNumber)}</h3>
          <span>${items.length} highlight${items.length === 1 ? "" : "s"}</span>
        </div>
        <div class="sidebarHighlightList">
          ${items.map((highlight) => {
            const expanded = state.expandedHighlightIds.has(highlight.id);
            const isSelected = state.selectedHighlightId === highlight.id;
            return `
            <div
              class="sidebarHighlightItem${isSelected ? " is-selected" : ""}"
              data-highlight-id="${escapeAttribute(highlight.id)}"
              data-group-id="${escapeAttribute(highlight.groupId ?? "")}"
            >
              <div class="sidebarHighlightCard">
                <button
                  type="button"
                  class="sidebarHighlightFocus"
                  data-action="focus-highlight"
                  data-page-number="${highlight.pageNumber}"
                  data-highlight-id="${escapeAttribute(highlight.id)}"
                >
                  <div class="sidebarHighlightHeader">
                    <div class="sidebarHighlightDotRow">
                      <span class="sidebarHighlightColorDot is-${escapeHtml(normalizeHighlightColor(highlight.color))}"></span>
                      <span class="sidebarHighlightPage">p. ${escapeHtml(String(highlight.pageNumber ?? "?"))}</span>
                    </div>
                    ${isSelected ? '<span class="sidebarHighlightSelectedMark" aria-hidden="true">&#10003;</span>' : ""}
                  </div>
                  <div class="sidebarHighlightText${expanded ? " is-expanded" : ""}">${escapeHtml(highlight.exact)}</div>
                </button>
                <div class="sidebarHighlightActions">
                  <button
                    type="button"
                    class="sidebarHighlightExpand"
                    data-action="toggle-highlight-expand"
                    data-highlight-id="${escapeAttribute(highlight.id)}"
                  >
                    ${expanded ? "collapse" : "expand"}
                  </button>
                </div>
              </div>
            </div>
            `;
          }).join("")}
        </div>
      </article>
    `)
    .join("");

  const selectedHighlight = highlights.find((item) => item.id === state.selectedHighlightId) ?? null;

  return `
    <section class="sidebarSection">
      <div class="sidebarHighlightCollection">
        <div class="sidebarHighlightCollectionHead">
          <div class="sidebarContextLabel">Highlights</div>
          <div class="sidebarHighlightCollectionMeta">${highlights.length} item${highlights.length === 1 ? "" : "s"}</div>
        </div>
        ${sections}
      </div>
      <div class="sidebarHighlightsFooter">
        <button
          type="button"
          class="sidebarUseContextButton"
          data-action="use-selected-context"
          ${selectedHighlight ? "" : "disabled"}
        >
          Use selected as context &rarr;
        </button>
      </div>
    </section>
  `;
}

function renderNotesTab(highlights, notesHint) {
  const selectedHighlight = highlights.find((item) => item.id === state.selectedHighlightId) ?? null;

  return `
    <section class="sidebarSection">
      <div class="sidebarSectionHeader">
        <h3>Notes</h3>
        <span>${selectedHighlight ? `Target ${selectedHighlight.id.slice(0, 8)}` : "No highlight selected"}</span>
      </div>

      ${selectedHighlight ? `
        <div class="sidebarNoteTargetCard">
          <div class="sidebarNoteTargetMeta">Selected highlight</div>
          <div class="sidebarContextText">${escapeHtml(selectedHighlight.exact)}</div>
          <div class="sidebarNoteTargetMeta">${escapeHtml(formatHighlightColorLabel(selectedHighlight.color))} highlight on page ${escapeHtml(String(selectedHighlight.pageNumber ?? "?"))}</div>
        </div>

        <label class="sidebarField">
          <span>Note draft</span>
          <textarea
            name="noteDraft"
            data-highlight-id="${escapeAttribute(selectedHighlight.id)}"
            rows="8"
            placeholder="Write a note for this highlight"
          ></textarea>
        </label>
      ` : `
        <div class="sidebarEmptyState">Select a highlight from the highlights tab to attach a note.</div>
      `}

      <div class="sidebarHint">${notesHint}</div>
    </section>
  `;
}

function renderHighlightMenu(highlights) {
  const menu = state.highlightMenu;
  if (!menu) {
    return "";
  }

  const highlight = highlights.find((item) => item.id === menu.highlightId) ?? null;
  if (!highlight) {
    queueMicrotask(() => closeHighlightMenu());
    return "";
  }

  const colors = ["yellow", "teal", "coral"];
  const top = Math.max(12, Math.min(menu.y, window.innerHeight - 220));
  const left = Math.max(12, Math.min(menu.x, window.innerWidth - 220));

  return `
    <div
      class="sidebarHighlightMenu"
      style="left: ${left}px; top: ${top}px;"
      role="menu"
      aria-label="Highlight actions"
    >
      <div class="sidebarHighlightMenuHeader">
        <div class="sidebarHighlightMenuLabel">Highlight</div>
        <button type="button" class="sidebarHighlightMenuClose" data-action="close-highlight-menu">Close</button>
      </div>
      <div class="sidebarHighlightMenuSection">
        <div class="sidebarHighlightMenuLabel">Color</div>
        <div class="sidebarHighlightMenuChoices">
          ${colors.map((color) => `
            <button
              type="button"
              class="sidebarColorSwatch${normalizeHighlightColor(highlight.color) === color ? " is-active" : ""} is-${color}"
              data-action="set-highlight-color"
              data-color="${color}"
              data-highlight-id="${escapeAttribute(highlight.id)}"
              data-group-id="${escapeAttribute(highlight.groupId ?? "")}"
              aria-pressed="${normalizeHighlightColor(highlight.color) === color ? "true" : "false"}"
              title="${escapeHtml(formatHighlightColorLabel(color))}"
            >
              <span class="sr-only">${escapeHtml(formatHighlightColorLabel(color))}</span>
            </button>
          `).join("")}
        </div>
      </div>
      <div class="sidebarHighlightMenuSection">
        <button
          type="button"
          class="sidebarHighlightMenuDelete"
          data-action="delete-highlight"
          data-highlight-id="${escapeAttribute(highlight.id)}"
          data-group-id="${escapeAttribute(highlight.groupId ?? "")}"
        >
          Delete highlight
        </button>
      </div>
    </div>
  `;
}

function renderMessage(message) {
  const roleClass = message.role === "assistant" ? "is-assistant" : "is-user";
  return `
    <article class="sidebarMessage ${roleClass}">
      <div class="sidebarMessageRole">${escapeHtml(message.role)}</div>
      <div class="sidebarMessageContent">${escapeHtml(message.content)}</div>
    </article>
  `;
}

function injectStyles() {
  if (document.getElementById("librarianSidebarStyles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "librarianSidebarStyles";
  style.textContent = `
    .sidebarShell {
      height: 100%;
      display: flex;
      flex-direction: column;
      color: #eef4fb;
      font-size: 0.9rem;
      position: relative;
    }

    .sidebarHeader {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 1rem 1rem 0.65rem;
    }

    .sidebarEyebrow {
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: rgba(226, 236, 248, 0.66);
    }

    .sidebarTitle {
      margin: 0.15rem 0 0;
      font-size: 1.15rem;
      line-height: 1.15;
    }

    .sidebarSummaryLabel,
    .sidebarContextLabel,
    .sidebarMessageRole,
    .sidebarHint,
    .sidebarThreadPill,
    .sidebarEmptyTitle,
    .sidebarEmptyBody,
    .sidebarNoteTargetMeta {
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: rgba(226, 236, 248, 0.66);
    }

    .sidebarTab,
    .sidebarComposerActions button,
    .sidebarHighlightItem,
    .sidebarHighlightFocus,
    .sidebarHighlightDelete {
      appearance: none;
      border: 0;
      border-radius: 0.85rem;
      font: inherit;
    }

    .sidebarTab,
    .sidebarComposerActions button,
    .sidebarHighlightFocus,
    .sidebarHighlightDelete {
      cursor: pointer;
      transition: background 120ms ease, transform 120ms ease;
    }

    .sidebarSummary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.6rem;
      padding: 1rem 1rem 0.85rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .sidebarSummaryStat {
      padding: 0.7rem 0.8rem;
      border-radius: 0.9rem;
      background: rgba(255, 255, 255, 0.05);
    }

    .sidebarSummaryStat strong {
      display: block;
      font-size: 1rem;
      margin-top: 0.25rem;
      color: #fff;
    }

    .sidebarStatusCard {
      margin: 0 1rem 0.25rem;
      padding: 0.8rem 0.9rem;
      border-radius: 1rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.05);
    }

    .sidebarStatusCard.is-offline {
      background: rgba(255, 99, 71, 0.08);
      border-color: rgba(255, 99, 71, 0.2);
    }

    .sidebarStatusCard.is-connected {
      background: rgba(110, 255, 179, 0.08);
      border-color: rgba(110, 255, 179, 0.18);
    }

    .sidebarStatusLabel,
    .sidebarStatusMeta {
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: rgba(226, 236, 248, 0.66);
    }

    .sidebarStatusText {
      margin-top: 0.3rem;
      color: #fff;
      font-weight: 600;
    }

    .sidebarStatusMeta {
      margin-top: 0.2rem;
      text-transform: none;
      letter-spacing: 0;
    }

    .sidebarColorCard {
      margin: 0 1rem 0.25rem;
      padding: 0.85rem 0.9rem;
      border-radius: 1rem;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      display: grid;
      gap: 0.6rem;
    }

    .sidebarColorHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }

    .sidebarColorValue {
      font-size: 0.8rem;
      color: #fff;
    }

    .sidebarColorChoices {
      display: flex;
      gap: 0.5rem;
    }

    .sidebarColorSwatch {
      width: 1.4rem;
      height: 1.4rem;
      border-radius: 999px;
      border: 2px solid transparent;
      cursor: pointer;
      padding: 0;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12) inset;
    }

    .sidebarColorSwatch.is-active {
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85), 0 0 0 4px rgba(0, 0, 0, 0.25);
    }

    .sidebarColorSwatch.is-yellow {
      background: rgba(255, 230, 120, 0.95);
    }

    .sidebarColorSwatch.is-teal {
      background: rgba(85, 225, 214, 0.95);
    }

    .sidebarColorSwatch.is-coral {
      background: rgba(255, 154, 122, 0.95);
    }

    .sidebarTabs {
      display: flex;
      gap: 0.5rem;
      padding: 0.75rem 1rem 0.5rem;
    }

    .sidebarTab {
      flex: 1;
      background: rgba(255, 255, 255, 0.06);
      color: #e4edf8;
      padding: 0.55rem 0.7rem;
    }

    .sidebarTab.is-active {
      background: rgba(255, 230, 0, 0.18);
      color: #fff;
    }

    .sidebarBody {
      flex: 1;
      overflow: auto;
      padding: 0 1rem 1rem;
    }

    .sidebarSection {
      display: grid;
      gap: 0.75rem;
    }

    .sidebarSectionHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }

    .sidebarSectionHeader h3 {
      margin: 0;
      font-size: 1rem;
    }

    .sidebarThreadCard,
    .sidebarNoteTargetCard,
    .sidebarContextCard,
    .sidebarHighlightGroup,
    .sidebarMessage,
    .sidebarComposer,
    .sidebarField textarea {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .sidebarThreadCard,
    .sidebarNoteTargetCard,
    .sidebarContextCard,
    .sidebarHighlightGroup,
    .sidebarMessage,
    .sidebarComposer {
      border-radius: 1rem;
      padding: 0.85rem;
    }

    .sidebarThreadCard,
    .sidebarNoteTargetCard {
      display: grid;
      gap: 0.55rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .sidebarThreadHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }

    .sidebarThreadPill {
      padding: 0.24rem 0.55rem;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      text-transform: uppercase;
      font-size: 0.68rem;
      white-space: nowrap;
    }

    .sidebarContextText {
      margin-top: 0.4rem;
      color: #fff;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .sidebarHighlightCollection {
      display: grid;
      gap: 0.85rem;
    }

    .sidebarHighlightCollectionHead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0 0.1rem;
    }

    .sidebarHighlightCollectionMeta {
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: rgba(226, 236, 248, 0.66);
    }

    .sidebarEmptyState {
      padding: 1rem;
      border-radius: 1rem;
      color: rgba(226, 236, 248, 0.8);
      background: rgba(255, 255, 255, 0.05);
      display: grid;
      gap: 0.35rem;
    }

    .sidebarEmptyTitle {
      color: #fff;
    }

    .sidebarEmptyBody {
      text-transform: none;
      letter-spacing: 0;
      color: rgba(226, 236, 248, 0.74);
    }

    .sidebarMessageList,
    .sidebarHighlightList {
      display: grid;
      gap: 0.55rem;
    }

    .sidebarMessage {
      display: grid;
      gap: 0.35rem;
    }

    .sidebarMessage.is-user {
      background: rgba(255, 255, 255, 0.08);
    }

    .sidebarMessage.is-assistant {
      background: rgba(255, 230, 0, 0.12);
    }

    .sidebarComposer {
      display: grid;
      gap: 0.65rem;
    }

    .sidebarComposer textarea,
    .sidebarField textarea {
      width: 100%;
      min-height: 5rem;
      resize: vertical;
      border-radius: 0.9rem;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(6, 14, 24, 0.82);
      color: #fff;
      padding: 0.75rem;
      font: inherit;
      outline: none;
      caret-color: #fff;
      color-scheme: dark;
    }

    .sidebarComposer textarea::placeholder,
    .sidebarField textarea::placeholder {
      color: rgba(226, 236, 248, 0.54);
    }

    .sidebarComposerActions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }

    .sidebarComposerActions button {
      padding: 0.5rem 0.8rem;
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    .sidebarComposerActions button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .sidebarHighlightItem {
      display: grid;
      text-align: left;
      color: #fff;
      border-radius: 1rem;
    }

    .sidebarHighlightItem.is-selected {
      box-shadow: 0 0 0 1px rgba(212, 177, 85, 0.42) inset;
    }

    .sidebarHighlightCard {
      display: grid;
      gap: 0.55rem;
      padding: 0.85rem 0.85rem 0.75rem;
      border-radius: 1rem;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-left: 3px solid transparent;
    }

    .sidebarHighlightItem.is-selected .sidebarHighlightCard {
      border-left-color: rgba(212, 177, 85, 0.95);
      background: rgba(212, 177, 85, 0.08);
    }

    .sidebarHighlightFocus {
      text-align: left;
      padding: 0;
      background: transparent;
      color: inherit;
      display: grid;
      gap: 0.45rem;
    }

    .sidebarHighlightHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }

    .sidebarHighlightDotRow {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }

    .sidebarHighlightPage {
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: rgba(226, 236, 248, 0.66);
      white-space: nowrap;
    }

    .sidebarHighlightSelectedMark {
      color: rgba(212, 177, 85, 0.98);
      font-size: 0.95rem;
      line-height: 1;
      flex: 0 0 auto;
    }

    .sidebarHighlightColorDot {
      width: 0.72rem;
      height: 0.72rem;
      margin-top: 0;
      border-radius: 999px;
      flex: 0 0 auto;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25) inset;
    }

    .sidebarHighlightColorDot.is-yellow {
      background: rgba(255, 230, 120, 0.95);
    }

    .sidebarHighlightColorDot.is-teal {
      background: rgba(85, 225, 214, 0.95);
    }

    .sidebarHighlightColorDot.is-coral {
      background: rgba(255, 154, 122, 0.95);
    }

    .sidebarHighlightActions {
      display: flex;
      justify-content: flex-end;
    }

    .sidebarHighlightText {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
      word-break: break-word;
      white-space: normal;
      line-height: 1.45;
      color: rgba(248, 243, 235, 0.96);
    }

    .sidebarHighlightText.is-expanded {
      display: block;
      -webkit-line-clamp: unset;
    }

    .sidebarHighlightExpand,
    .sidebarUseContextButton {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 0.9rem;
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      font: inherit;
      cursor: pointer;
      transition: background 120ms ease, transform 120ms ease, border-color 120ms ease;
    }

    .sidebarHighlightExpand {
      padding: 0.48rem 0.8rem;
      margin-left: auto;
      font-size: 0.8rem;
      text-transform: lowercase;
    }

    .sidebarUseContextButton {
      width: 100%;
      padding: 0.8rem 0.95rem;
      text-align: center;
      font-size: 0.92rem;
      letter-spacing: 0.03em;
      text-transform: lowercase;
    }

    .sidebarUseContextButton:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .sidebarHighlightsFooter {
      padding-top: 0.15rem;
    }

    .sidebarHighlightMenu {
      position: fixed;
      z-index: 20;
      width: 14rem;
      border-radius: 1rem;
      padding: 0.85rem;
      background: rgba(12, 20, 32, 0.98);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
      display: grid;
      gap: 0.8rem;
      backdrop-filter: blur(12px);
    }

    .sidebarHighlightMenuHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .sidebarHighlightMenuSection {
      display: grid;
      gap: 0.45rem;
    }

    .sidebarHighlightMenuLabel {
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: rgba(226, 236, 248, 0.66);
    }

    .sidebarHighlightMenuChoices {
      display: flex;
      gap: 0.45rem;
    }

    .sidebarHighlightMenuClose,
    .sidebarHighlightMenuDelete {
      appearance: none;
      border: 0;
      border-radius: 0.85rem;
      font: inherit;
      cursor: pointer;
      transition: background 120ms ease, transform 120ms ease;
    }

    .sidebarHighlightMenuClose {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      padding: 0.35rem 0.6rem;
      font-size: 0.78rem;
    }

    .sidebarHighlightMenuDelete {
      width: 100%;
      background: rgba(255, 99, 71, 0.18);
      color: #fff;
      padding: 0.55rem 0.75rem;
      text-align: center;
    }

    .sidebarHighlightText {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .sidebarHighlightMeta,
    .sidebarHint {
      color: rgba(226, 236, 248, 0.68);
    }

    .sidebarField {
      display: grid;
      gap: 0.45rem;
    }

    .sidebarField span {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: rgba(226, 236, 248, 0.66);
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    /* Design refresh */
    .sidebarShell {
      background:
        radial-gradient(circle at top, rgba(255, 215, 128, 0.06), transparent 34%),
        linear-gradient(180deg, #10100e 0%, #161613 100%);
      color: #f4efe7;
      font-family: "Georgia", "Times New Roman", serif;
    }

    .sidebarHeader,
    .sidebarSummary,
    .sidebarStatusCard,
    .sidebarColorCard,
    .sidebarTabs,
    .sidebarBody {
      border-color: rgba(255, 255, 255, 0.08);
    }

    .sidebarTitle,
    .sidebarSectionHeader h3,
    .sidebarColorValue {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      letter-spacing: 0.06em;
    }

    .sidebarEyebrow,
    .sidebarSummaryLabel,
    .sidebarContextLabel,
    .sidebarMessageRole,
    .sidebarHint,
    .sidebarStatusLabel,
    .sidebarStatusMeta,
    .sidebarHighlightMeta,
    .sidebarField span,
    .sidebarHighlightMenuLabel {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      letter-spacing: 0.08em;
    }

    .sidebarContextCard,
    .sidebarHighlightGroup,
    .sidebarMessage,
    .sidebarComposer,
    .sidebarField textarea,
    .sidebarStatusCard,
    .sidebarColorCard,
    .sidebarHighlightMenu {
      border-radius: 0;
    }

    .sidebarTab,
    .sidebarComposerActions button,
    .sidebarHighlightFocus,
    .sidebarHighlightMenuClose,
    .sidebarHighlightMenuDelete {
      border-radius: 0;
    }

    .sidebarSummaryStat,
    .sidebarStatusCard,
    .sidebarColorCard,
    .sidebarHighlightItem,
    .sidebarHighlightMenu {
      background: rgba(255, 255, 255, 0.035);
    }

    .sidebarMessage.is-user {
      background: rgba(255, 255, 255, 0.06);
    }

    .sidebarMessage.is-assistant {
      background: rgba(199, 162, 74, 0.12);
    }

    .sidebarTab.is-active {
      background: rgba(199, 162, 74, 0.18);
      color: #fff8ec;
    }

    .sidebarComposer textarea,
    .sidebarField textarea {
      background: rgba(9, 9, 8, 0.88);
      border-color: rgba(255, 255, 255, 0.1);
    }

    .sidebarColorSwatch.is-active {
      box-shadow: 0 0 0 2px rgba(255, 248, 236, 0.9), 0 0 0 4px rgba(0, 0, 0, 0.26);
    }

    .sidebarHighlightItem.is-selected {
      background: rgba(199, 162, 74, 0.14);
      box-shadow: 0 0 0 1px rgba(199, 162, 74, 0.22) inset;
    }

    .sidebarHighlightMenuDelete {
      background: rgba(199, 162, 74, 0.16);
    }
  `;
  document.head.appendChild(style);
}

function isTypingTarget(target) {
  return Boolean(
    target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLButtonElement && target.closest?.("form"),
  );
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}?`;
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(input) {
  return escapeHtml(input).replaceAll("`", "&#96;");
}

function getViewerHighlightColor() {
  const viewer = window.librarianViewer;
  if (typeof viewer?.getHighlightColor === "function") {
    return normalizeHighlightColor(viewer.getHighlightColor());
  }
  return normalizeHighlightColor(state.highlightColor);
}

function setHighlightColor(color, target = {}) {
  const nextColor = normalizeHighlightColor(color);
  state.highlightColor = nextColor;

  document.dispatchEvent(
    new CustomEvent("librarian:sidebar:set-highlight-color", {
      detail: {
        color: nextColor,
        highlightId: typeof target.highlightId === "string" ? target.highlightId : "",
        groupId: typeof target.groupId === "string" ? target.groupId : "",
      },
    }),
  );

  render();
}

function normalizeHighlightColor(color) {
  return ["yellow", "teal", "coral"].includes(color) ? color : "yellow";
}

function formatHighlightColorLabel(color) {
  const normalized = normalizeHighlightColor(color);
  if (normalized === "teal") {
    return "Teal";
  }
  if (normalized === "coral") {
    return "Coral";
  }
  return "Yellow";
}

function notesStorageKey(documentUrl) {
  return `notes:v1:${hashString(normalizeDocumentUrl(documentUrl))}`;
}

function hashString(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeDocumentUrl(documentUrl) {
  try {
    const url = new URL(documentUrl, window.location.href);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return String(documentUrl);
  }
}

async function storageGet(key) {
  try {
    if (chrome?.storage?.local?.get) {
      const result = await chrome.storage.local.get([key]);
      return result?.[key] ?? null;
    }
  } catch (error) {
    console.warn("[Librarian AI] sidebar storageGet chrome.storage failed", error);
  }

  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn("[Librarian AI] sidebar storageGet localStorage failed", error);
    return null;
  }
}

async function storageSet(key, value) {
  try {
    if (chrome?.storage?.local?.set) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
  } catch (error) {
    console.warn("[Librarian AI] sidebar storageSet chrome.storage failed", error);
  }

  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("[Librarian AI] sidebar storageSet localStorage failed", error);
  }
}

function captureRenderState() {
  const activeElement = document.activeElement;
  const stateSnapshot = {
    sidebarBodyScrollTop: sidebarEl.querySelector(".sidebarBody")?.scrollTop ?? 0,
    activeField: null,
  };

  if (activeElement instanceof HTMLTextAreaElement && sidebarEl.contains(activeElement)) {
    stateSnapshot.activeField = {
      name: activeElement.name,
      value: activeElement.value,
      selectionStart: activeElement.selectionStart,
      selectionEnd: activeElement.selectionEnd,
      selectionDirection: activeElement.selectionDirection,
      highlightId: activeElement.dataset.highlightId ?? "",
    };
  }

  return stateSnapshot;
}

function restoreRenderState(snapshot) {
  if (!snapshot) {
    return;
  }

  const sidebarBody = sidebarEl.querySelector(".sidebarBody");
  if (sidebarBody) {
    sidebarBody.scrollTop = snapshot.sidebarBodyScrollTop ?? 0;
  }

  const activeField = snapshot.activeField;
  if (!activeField) {
    return;
  }

  let target = null;
  if (activeField.name === "chatPrompt") {
    target = sidebarEl.querySelector('textarea[name="chatPrompt"]');
  } else if (activeField.name === "noteDraft") {
    target = sidebarEl.querySelector(
      `textarea[name="noteDraft"][data-highlight-id="${CSS.escape(activeField.highlightId)}"]`,
    );
  }

  if (!(target instanceof HTMLTextAreaElement)) {
    return;
  }

  target.value = activeField.value;
  target.focus({ preventScroll: true });

  if (typeof activeField.selectionStart === "number" && typeof activeField.selectionEnd === "number") {
    try {
      target.setSelectionRange(activeField.selectionStart, activeField.selectionEnd, activeField.selectionDirection ?? "none");
    } catch {
      // Ignore selection restore failures for edge cases.
    }
  }
}

function scheduleSaveNotes() {
  const documentUrl = state.documentUrl;
  if (!documentUrl) {
    return;
  }

  const noteDrafts = Object.fromEntries(state.noteDrafts.entries());

  if (saveNotesTimer) {
    clearTimeout(saveNotesTimer);
  }

  saveNotesTimer = setTimeout(() => {
    void storageSet(notesStorageKey(documentUrl), {
      version: 1,
      documentUrl,
      updatedAt: Date.now(),
      noteDrafts,
    });
  }, 200);
}

