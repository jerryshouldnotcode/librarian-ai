# Librarian AI — Design Document

> A Chrome extension for annotating, highlighting, and chatting with academic PDFs in an extension-controlled viewer.

---

## 1. Product Vision

Librarian AI intercepts PDF navigation and renders documents in its own viewer page, giving the extension full DOM ownership. Users highlight text, attach annotations, and chat with an AI that has awareness of what's selected — all without leaving the PDF environment.

**Core principle:** The PDF is primary. Every sidebar interaction must be completable without navigating away or opening a new window.

---

## 2. Current State

| Feature | Status |
|---|---|
| Extension scaffold (MV3) | ✅ Done |
| PDF redirect via `declarativeNetRequest` | ✅ Done |
| PDF.js viewer page (`viewer.html`) | ✅ Done |
| Page render lifecycle events (`pagerendered`, `textlayerrendered`) | ✅ Done |
| Text selection detection in text layer | ✅ Done |
| Selection → PDF-space anchor conversion | ✅ Done |
| Coordinate-based highlight overlay rendering | ✅ Done |
| Overlay redraw on zoom/resize | ✅ Done |
| Reload-safe highlight rehydration | ✅ Done |
| Sidebar shell + toggle | ✅ Done |
| Sidebar isolated from viewer rendering | ✅ Done |
| Docked desktop layout + responsive behavior | ✅ Done |
| Tabs: chat, highlights, notes | ✅ Done |
| Highlights list + notes panel | ✅ Done |
| Annotation editing UI | ✅ Done |
| Jump-to-source for highlights/annotations | ✅ Done |
| Viewer ↔ sidebar custom event contracts | ✅ Done |
| Chat UI with message history | ✅ Done |
| Canonical document ID derivation | 🔲 Pending |
| Local storage read/write for `Document` | 🔲 Pending |
| Chat persistence per document | 🔲 Pending |
| OpenAI integration via `LLMProvider` | 🔲 Pending |
| Viewer ↔ background messaging for chat | 🔲 Pending |

**Stack:** Vanilla JS (`.mjs` modules), PDF.js, Chrome Extension APIs (Manifest V3)  
**AI Provider (MVP):** OpenAI (user-supplied API key, stored locally)  
**Storage:** `chrome.storage.local`

---

## 3. Architecture

### 3.1 High-Level

```
[Background Service Worker]
        │
        ├── intercepts PDF navigation (declarativeNetRequest)
        ├── mediates LLM API calls
        └── mediates storage operations
                │
                ▼
[PDF Viewer Page — viewer.html]  (extension-controlled)
        │
        ├── [PDF.js Renderer]      renders PDF, exposes text layer
        ├── [viewer.mjs]           selection, highlight overlays, source-scroll
        └── [sidebar.mjs]         chat UI, highlights list, notes panel
                       │
                       ├── custom document events
                       └── [Background]  → LLM API
```

The extension owns `viewer.html` entirely — no content script injection, no unstable DOM overlay. Viewer scripts and sidebar are standard page scripts loaded by `viewer.html`.

### 3.2 File Structure

```
librarian/
├── manifest.json
├── background/
│   └── service-worker.js      # PDF redirect, LLM proxy, storage coordination
├── viewer/
│   ├── viewer.html            # Extension-controlled PDF viewer page
│   ├── viewer.mjs             # Selection detection, highlight rendering, page scroll
│   └── sidebar.mjs            # Sidebar state, tab switching, chat/notes/highlights UI
├── shared/
│   ├── storage.js             # chrome.storage.local abstraction
│   ├── llm.js                 # LLMProvider interface + OpenAI implementation
│   └── models.js              # Shared type definitions (JSDoc)
└── assets/
    └── icons/
```

### 3.3 Component Responsibilities

| Component | File | Owns |
|---|---|---|
| Background | `service-worker.js` | PDF redirect rules, API key storage, LLM request proxy, storage ops |
| Viewer | `viewer.mjs` | PDF.js lifecycle, text selection, anchor conversion, overlay rendering, zoom/resize redraws |
| Sidebar | `sidebar.mjs` | Sidebar state, tab switching, chat thread rendering, highlights list, notes editing, draft preservation |
| Storage | `shared/storage.js` | All `chrome.storage.local` reads/writes via typed API |
| LLM | `shared/llm.js` | `LLMProvider` interface, OpenAI implementation |

---

## 4. Data Models

```ts
type Highlight = {
  id: string
  text: string
  anchor: {
    page: number
    x: number       // PDF coordinate space
    y: number
    width: number
    height: number
  }
  color: string     // color token key
}

type Annotation = {
  id: string
  highlightId: string
  note: string
}

type Message = {
  role: "user" | "assistant"
  content: string
  timestamp: number
}

// Single thread per document in MVP
type Chat = {
  id: string
  messages: Message[]
  createdAt: number
}

// Top-level storage unit, keyed by Document.id
type Document = {
  id: string          // SHA-256 of normalized URL (query params + fragments stripped)
  url: string         // original URL, display only
  highlights: Highlight[]
  annotations: Annotation[]
  chat: Chat
}
```

### Document ID Derivation

```js
// Normalize: strip query params and fragment
const normalized = new URL(pdfUrl);
normalized.search = "";
normalized.hash = "";
const canonical = normalized.toString();

// SHA-256 hash → hex string
const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
const id = Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
// → stored as Document.id
```

Local file paths (`file://`) are hashed as-is without normalization.

---

## 5. State Models

### App State (viewer-scoped, in-memory)

```ts
type AppState = {
  documentId: string
  highlights: Highlight[]
  annotations: Annotation[]
  chat: Chat
  selectedText: string | null
}
```

### Sidebar State (sidebar-scoped, in-memory)

```ts
type SidebarTab = "chat" | "highlights" | "notes"

type SidebarState = {
  isOpen: boolean
  activeTab: SidebarTab
  selectedText: string | null
  selectedHighlightId: string | null
  pendingPrompt: string | null
}
```

Neither state object is persisted directly — `AppState` hydrates from storage on load; `SidebarState` is ephemeral per session (drafts survive reflow but not reload).

---

## 6. Event Contracts

Viewer and sidebar communicate exclusively through custom `document` events — no shared mutable globals.

| Event | Direction | Payload | Trigger |
|---|---|---|---|
| `librarian:documentloaded` | viewer → sidebar | `{ url: string, pageCount: number }` | PDF.js finishes initial render |
| `librarian:selectioncaptured` | viewer → sidebar | `{ text: string, pages: number[] }` | User completes a text selection |
| `librarian:highlightschanged` | viewer → sidebar | `{ highlights: Highlight[] }` | Highlight added or deleted |
| `librarian:sidebar:focus-highlight` | sidebar → viewer | `{ highlightId: string }` | User clicks a highlight in the sidebar list |

### Messaging: Viewer/Sidebar → Background

```ts
// Request LLM response
{
  type: "SEND_MESSAGE",
  payload: {
    message: string
    context?: string   // omitted when no selection or highlight context exists
  }
}

// Persist a new highlight
{
  type: "CREATE_HIGHLIGHT",
  payload: Highlight
}
```

---

## 7. Core Feature Behavior

### 7.1 Highlighting

- User selects text in the PDF.js text layer
- Selection converted to PDF-space coordinates (page + bounding box) — not DOM offsets
- Overlay `<div>` elements rendered at those coordinates
- On zoom or resize, PDF.js fires `pagerendered`; overlays are fully redrawn from stored coordinates
- Highlights gated on `textlayerrendered` — never rendered before the text layer exists

**Why coordinate-based anchoring:** PDF.js rebuilds its text layer DOM on every zoom and resize. DOM offset anchoring would require re-querying unstable nodes. Coordinate anchoring sidesteps this entirely.

### 7.2 Annotations

- Attached to a specific `Highlight` via `highlightId`
- Editable after creation
- Inline editor in the sidebar Highlights tab
- Persisted via storage layer on save

### 7.3 AI Chat

**Context priority:**
1. Selected text (highest — injected when present)
2. Recent highlights (fallback when no active selection)
3. Empty context (bare question)

**Prompt template:**
```
Context:
{selected_text_or_recent_highlights}

User:
{question}

Instructions:
Answer using the context above if relevant.
```

**Behavior:**
- If selected text exists: show a dismissible context chip in the sidebar — *"Using selection as context"*
- Switching documents resets transient sidebar state (drafts, selected text) but preserves each document's chat thread
- Chat history persists across reload via `Document.chat` in storage

### 7.4 Persistence

- All data scoped per `Document.id`
- Rehydration on load: storage read after `textlayerrendered`; highlights redrawn immediately
- No data loss on reload, zoom, or resize
- No backend — all data stays on-device in `chrome.storage.local`

---

## 8. Storage API

All `chrome.storage.local` access goes through `shared/storage.js`. No component calls storage directly.

```js
// shared/storage.js

export async function getDocument(documentId) { ... }
export async function saveDocument(document) { ... }

export async function saveHighlight(documentId, highlight) { ... }
export async function deleteHighlight(documentId, id) { ... }

export async function saveAnnotation(documentId, annotation) { ... }
export async function updateAnnotation(documentId, id, note) { ... }
export async function deleteAnnotation(documentId, id) { ... }

export async function getChatHistory(documentId) { ... }
export async function appendMessage(documentId, message) { ... }
export async function clearChatHistory(documentId) { ... }
```

---

## 9. LLM Interface

```ts
interface LLMProvider {
  sendMessage(input: {
    prompt: string
    context?: string
  }): Promise<string>
}
```

MVP implementation: `OpenAIProvider` in `shared/llm.js`. User supplies their own API key; stored in `chrome.storage.local` and transmitted only to OpenAI — never to extension servers. The interface is intentionally minimal so Phase 3 additions (Claude, Perplexity) are a new class, not a refactor.

---

## 10. UI/UX Specification

### 10.1 Viewer Layout

```
┌─────────────────────────────────────────┬──────────────────┐
│                                         │                  │
│          PDF.js Viewer                  │    Sidebar       │
│                                         │    360px fixed   │
│                                         │                  │
└─────────────────────────────────────────┴──────────────────┘
                                          ↑
                               [toggle button] — fixed to edge
```

- Sidebar docked right, pushes viewer left (does not overlay)
- On small screens: overlay mode (sidebar floats over the PDF)
- Collapsed state: sidebar hidden, toggle button still visible

### 10.2 Sidebar Anatomy

```
┌──────────────────────────────┐
│  📖 Librarian      [×]       │  ← header + close
│  document-title.pdf          │  ← active document label
├──────────┬────────┬──────────┤
│  Chat    │  High. │  Notes   │  ← tab bar (sticky)
├──────────┴────────┴──────────┤
│                              │
│   [tab content — scrollable] │
│                              │
├──────────────────────────────┤
│   [footer action area]       │  ← context-dependent
└──────────────────────────────┘
```

### 10.3 Chat Tab

- Message thread, newest at bottom, auto-scrolls on new message
- User messages: right-aligned, filled bubble
- Assistant messages: left-aligned, no bubble, plain text
- Input: textarea, `Enter` to send, `Shift+Enter` for newline
- If selected text exists: dismissible context chip above input — *"Using selection as context"*
- Loading state: ellipsis animation while awaiting response
- Empty state: *"Ask anything about this document."*

### 10.4 Highlights Tab

Each highlight entry:

```
┌──────────────────────────────┐
│ ░  "selected passage..."  p3 │  ← color swatch, truncated text, page number
│    Note: annotation text     │  ← annotation if present
│    [Edit note]         [×]   │  ← actions
└──────────────────────────────┘
```

- Clicking entry fires `librarian:sidebar:focus-highlight` → viewer scrolls to page
- *Edit note* expands inline textarea; saves on blur
- Entries grouped by page number
- Empty state: *"No highlights yet. Select text in the PDF to get started."*

### 10.5 Notes Tab

- Freeform per-document notes (Phase 3)
- MVP: tab visible, shows *"Coming soon"*

### 10.6 Highlight Toolbar

Appears near the selection when the user finishes selecting text:

```
[ Highlight ▾ ]  [ Annotate ]
```

- **Highlight:** saves with default color, injects overlay immediately
- **Annotate:** saves highlight + opens sidebar Highlights tab with annotation input focused
- Color picker: secondary popover from the Highlight button

### 10.7 Visual Style

**Aesthetic:** Dark, editorial. Dense information without visual noise — a tool for serious reading.

**Typography:**
- UI chrome, labels, tabs: `"DM Mono"` — monospaced, signals precision
- Chat messages, annotations, notes body: `"Lora"` — serif, reading-appropriate
- Fallbacks: `monospace`, `Georgia`

**Color tokens:**
```css
--bg-sidebar:     #111110;
--bg-surface:     #1a1a18;
--bg-input:       #222220;
--border:         #2e2e2b;
--text-primary:   #e8e6e0;
--text-secondary: #7a7870;
--text-muted:     #4a4845;
--accent:         #c9a84c;      /* amber — active states, context chips */
--accent-dim:     #c9a84c33;

/* Highlight overlay colors (semi-transparent) */
--hl-yellow:  #f5e642aa;        /* default */
--hl-green:   #4caf7daa;
--hl-blue:    #5b9bd5aa;
--hl-red:     #e05c5caa;
```

**Layout rules:**
- No border-radius on panel containers — sharp edges throughout
- `4px` radius on input fields only
- 1px solid `--border` on all dividing lines
- No drop shadows — borders only

---

## 11. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Highlight render time | < 50ms from selection confirm |
| Chat response latency | Provider-dependent (OpenAI) |
| API key storage | `chrome.storage.local` only; transmitted only to OpenAI |
| Text layer gating | Highlights must not render before `textlayerrendered` fires |
| Draft preservation | Unsent chat input and note edits survive PDF reflow (zoom, resize, page nav) |

---

## 12. Known Risks

| Risk | Mitigation |
|---|---|
| PDF redirect coverage | `declarativeNetRequest` handles links and address bar; blob URLs are a known limitation — document as explicit scope, no `webRequest` fallback (MV3 does not support blocking redirects via `webRequest`) |
| Text layer timing | Gate all highlight rendering on `textlayerrendered` |
| Zoom/resize reflow | Coordinate-based anchoring; redraw overlays on `pagerendered` |
| Context quality | Prefer selected text; tune prompt templates before expanding context sources |

---

## 13. Remaining Work (Phase 2 Completion)

- [ ] Canonical document ID derivation (SHA-256 of normalized URL)
- [ ] `chrome.storage.local` read/write for full `Document` model
- [ ] Chat persistence per document (`Document.chat`)
- [ ] Viewer ↔ background messaging for chat (`SEND_MESSAGE`)
- [ ] OpenAI integration via `LLMProvider`

**Phase 2 done when:**
1. User can ask a question about selected text via the sidebar
2. AI responds using the selected text as context
3. Chat persists after a page reload

---

## 14. Deferred (Phase 3+)

- Multi-model support (Claude, Perplexity) — `LLMProvider` interface already accommodates this
- Google Docs export
- Keyboard shortcut polish
- Notes tab (freeform per-document markdown editor)
- Embeddings + semantic search (Phase 4)
- Multi-document context (Phase 4)
- Cloud sync / backend (post-MVP)
