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
  draftMessage: "",
  messages: [],
  noteDrafts: new Map(),
};

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

  sidebarEl.addEventListener("click", onSidebarClick);
  sidebarEl.addEventListener("submit", onSidebarSubmit);
  sidebarEl.addEventListener("input", onSidebarInput);
}

function hydrateFromViewer() {
  const viewer = window.librarianViewer;
  if (Array.isArray(viewer?.highlights)) {
    state.selectedHighlightId ??= viewer.highlights[0]?.id ?? null;
  }
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
    state.draftMessage = "";
    state.messages = [];
    state.noteDrafts.clear();
    render();
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

  render();
}

function onSidebarClick(event) {
  const actionEl = event.target.closest?.("[data-action]");
  if (!actionEl) {
    return;
  }

  const action = actionEl.dataset.action;
  if (action === "toggle-sidebar") {
    event.preventDefault();
    toggleSidebar();
    return;
  }

  if (action === "set-tab") {
    event.preventDefault();
    setActiveTab(actionEl.dataset.tab ?? "chat");
    return;
  }

  if (action === "focus-highlight") {
    event.preventDefault();
    const pageNumber = Number(actionEl.dataset.pageNumber);
    const highlightId = actionEl.dataset.highlightId ?? null;
    if (Number.isFinite(pageNumber)) {
      state.selectedHighlightId = highlightId;
      dispatchFocusHighlight(pageNumber, highlightId);
      render();
    }
  }
}

function onSidebarSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  if (form.dataset.role === "chat-composer") {
    event.preventDefault();
    const input = form.querySelector('textarea[name="chatPrompt"]');
    const text = typeof input?.value === "string" ? input.value.trim() : "";
    if (!text) {
      return;
    }

    state.messages = [
      ...state.messages,
      {
        role: "user",
        content: text,
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: state.selectedText
          ? "Context captured. Provider wiring is still pending."
          : "No selection is active. Provider wiring is still pending.",
        timestamp: Date.now(),
      },
    ];
    state.draftMessage = "";
    render();
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

function syncSidebarWidth() {
  rootEl.style.setProperty("--sidebar-width", state.isOpen ? OPEN_WIDTH : CLOSED_WIDTH);
  sidebarEl.hidden = !state.isOpen;
  toggleEl.textContent = state.isOpen ? "Hide sidebar" : "Show sidebar";
}

function render() {
  syncSidebarWidth();

  const viewer = window.librarianViewer;
  const highlights = Array.isArray(viewer?.highlights) ? viewer.highlights : [];
  const documentLabel = state.documentUrl || "No PDF loaded";
  const contextText = truncateText(state.selectedText || "", 220);

  sidebarEl.innerHTML = `
    <div class="sidebarShell">
      <header class="sidebarHeader">
        <div>
          <div class="sidebarEyebrow">Document</div>
          <h2 class="sidebarTitle">Context</h2>
          <div class="sidebarMeta">${escapeHtml(documentLabel)}</div>
        </div>
        <button class="sidebarHeaderButton" type="button" data-action="toggle-sidebar">
          ${state.isOpen ? "Hide" : "Show"}
        </button>
      </header>

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
        ${TAB_ORDER.map((tab) => `
          <button
            type="button"
            class="sidebarTab${state.activeTab === tab ? " is-active" : ""}"
            data-action="set-tab"
            data-tab="${tab}"
          >
            ${tab}
          </button>
        `).join("")}
      </nav>

      <main class="sidebarBody">
        ${renderActiveTab(highlights, contextText)}
      </main>
    </div>
  `;

  const chatText = sidebarEl.querySelector('textarea[name="chatPrompt"]');
  if (chatText) {
    chatText.value = state.draftMessage;
  }

  const noteText = sidebarEl.querySelector('textarea[name="noteDraft"]');
  const selectedHighlight = highlights.find((item) => item.id === state.selectedHighlightId);
  if (noteText) {
    const draft = state.noteDrafts.get(state.selectedHighlightId ?? "") ?? "";
    noteText.value = draft;
    noteText.placeholder = selectedHighlight ? "Write a note for this highlight" : "Select a highlight first";
  }
}

function renderActiveTab(highlights, contextText) {
  if (state.activeTab === "highlights") {
    return renderHighlightsTab(highlights);
  }

  if (state.activeTab === "notes") {
    return renderNotesTab(highlights);
  }

  return renderChatTab(highlights, contextText);
}

function renderChatTab(highlights, contextText) {
  return `
    <section class="sidebarSection">
      <div class="sidebarSectionHeader">
        <h3>Chat</h3>
        <span>${state.messages.length} messages</span>
      </div>

      <div class="sidebarContextCard">
        <div class="sidebarContextLabel">Selected context</div>
        <div class="sidebarContextText">${contextText ? escapeHtml(contextText) : "Select text in the PDF to seed chat context."}</div>
      </div>

      <div class="sidebarMessageList" role="log" aria-live="polite">
        ${state.messages.length ? state.messages.map(renderMessage).join("") : `<div class="sidebarEmptyState">No messages yet. Ask a question about the current PDF.</div>`}
      </div>

      <form class="sidebarComposer" data-role="chat-composer">
        <textarea
          name="chatPrompt"
          rows="4"
          placeholder="Ask about the paper"
          spellcheck="true"
        ></textarea>
        <div class="sidebarComposerActions">
          <button type="submit">Send</button>
          <button type="button" data-action="set-tab" data-tab="highlights">View highlights</button>
        </div>
      </form>

      <div class="sidebarHint">${highlights.length ? "Highlights are available in the list below." : "Highlights will appear here after you select text."}</div>
    </section>
  `;
}

function renderHighlightsTab(highlights) {
  if (!highlights.length) {
    return `<div class="sidebarEmptyState">No highlights yet. Select text in the PDF to create one.</div>`;
  }

  const grouped = new Map();
  for (const highlight of highlights) {
    const key = String(highlight.pageNumber ?? "unknown");
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
          <span>${items.length} item${items.length === 1 ? "" : "s"}</span>
        </div>
        <div class="sidebarHighlightList">
          ${items.map((highlight) => `
            <button
              type="button"
              class="sidebarHighlightItem${state.selectedHighlightId === highlight.id ? " is-selected" : ""}"
              data-action="focus-highlight"
              data-page-number="${highlight.pageNumber}"
              data-highlight-id="${escapeAttribute(highlight.id)}"
            >
              <div class="sidebarHighlightText">${escapeHtml(highlight.exact)}</div>
              <div class="sidebarHighlightMeta">${escapeHtml(highlight.prefix || highlight.suffix ? "Context available" : "No context")}</div>
            </button>
          `).join("")}
        </div>
      </article>
    `)
    .join("");

  return `<section class="sidebarSection">${sections}</section>`;
}

function renderNotesTab(highlights) {
  const selectedHighlight = highlights.find((item) => item.id === state.selectedHighlightId) ?? null;

  return `
    <section class="sidebarSection">
      <div class="sidebarSectionHeader">
        <h3>Notes</h3>
        <span>${selectedHighlight ? `Highlight ${selectedHighlight.id.slice(0, 8)}` : "No highlight selected"}</span>
      </div>

      ${selectedHighlight ? `
        <div class="sidebarContextCard">
          <div class="sidebarContextLabel">Selected highlight</div>
          <div class="sidebarContextText">${escapeHtml(selectedHighlight.exact)}</div>
        </div>

        <label class="sidebarField">
          <span>Note</span>
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

      <div class="sidebarHint">Notes are currently stored in memory. Persistence can be wired to chrome.storage.local next.</div>
    </section>
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
    }

    .sidebarHeader {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 1rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .sidebarEyebrow,
    .sidebarSummaryLabel,
    .sidebarContextLabel,
    .sidebarMessageRole,
    .sidebarHint,
    .sidebarMeta {
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

    .sidebarMeta {
      margin-top: 0.35rem;
      text-transform: none;
      letter-spacing: 0;
      word-break: break-word;
    }

    .sidebarHeaderButton,
    .sidebarTab,
    .sidebarComposerActions button,
    .sidebarHighlightItem {
      appearance: none;
      border: 0;
      border-radius: 0.85rem;
      font: inherit;
    }

    .sidebarHeaderButton,
    .sidebarTab,
    .sidebarComposerActions button {
      cursor: pointer;
      transition: background 120ms ease, transform 120ms ease;
    }

    .sidebarHeaderButton {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      padding: 0.55rem 0.8rem;
    }

    .sidebarSummary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.6rem;
      padding: 0.85rem 1rem;
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

    .sidebarContextCard,
    .sidebarHighlightGroup,
    .sidebarMessage,
    .sidebarComposer,
    .sidebarField textarea {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .sidebarContextCard,
    .sidebarHighlightGroup,
    .sidebarMessage,
    .sidebarComposer {
      border-radius: 1rem;
      padding: 0.85rem;
    }

    .sidebarContextText {
      margin-top: 0.4rem;
      color: #fff;
      white-space: pre-wrap;
      word-break: break-word;
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

    .sidebarEmptyState {
      padding: 1rem;
      border-radius: 1rem;
      color: rgba(226, 236, 248, 0.8);
      background: rgba(255, 255, 255, 0.05);
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

    .sidebarHighlightItem {
      display: grid;
      gap: 0.25rem;
      text-align: left;
      padding: 0.75rem 0.8rem;
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      cursor: pointer;
    }

    .sidebarHighlightItem.is-selected {
      background: rgba(255, 230, 0, 0.16);
      box-shadow: 0 0 0 1px rgba(255, 230, 0, 0.24) inset;
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
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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
