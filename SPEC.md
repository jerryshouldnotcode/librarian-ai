# Librarian AI — Technical Specification

## 1. Overview

Librarian AI is a Chrome Extension that enhances PDF-based academic reading with inline annotations, context-aware AI chat, persistent document state, and optional export to external tools. PDFs are rendered using PDF.js inside an extension-controlled viewer page, giving the extension full ownership of the DOM.

**Primary goal:** Enable users to interact with academic papers without leaving the PDF environment.

---

## 2. Scope

### In Scope (MVP)

- Text highlighting and annotation
- Sidebar AI chat with context awareness
- Local persistence per document
- OpenAI integration (single provider; interface is pluggable for Phase 3)

### Out of Scope (MVP)

- Embeddings / vector database
- Multi-document reasoning
- Cloud sync

---

## 3. System Architecture

### 3.1 High-Level

```
[Background Service Worker]
        │
        ├── intercepts PDF navigation (declarativeNetRequest)
        │
        ▼
[PDF Viewer Page (extension-controlled)]
        │
        ├── [PDF.js Renderer]          renders PDF, exposes text layer
        ├── [Viewer Script]            handles selection, highlights
        └── [Sidebar Module]          chat UI, notes panel
                       │
                       ▼
                [LLM API Layer]
```

### 3.2 Components

#### Background Service Worker

Intercepts navigation to `.pdf` URLs and redirects them to the extension's viewer page. Also mediates LLM API calls and storage operations.

| | |
|---|---|
| **Key permission** | `declarativeNetRequest` for PDF redirect |
| **Outputs** | Redirected viewer URL, API responses |

---

#### PDF Viewer Page

A self-contained extension page (`viewer.html`) that hosts PDF.js. The extension fully owns this DOM, eliminating injection instability.

- Loads PDF.js and renders the target PDF
- Exposes a text layer (`<span>` elements) mapped to PDF coordinates
- Runs viewer scripts and the sidebar module as standard extension page scripts (not injected content scripts)

---

#### Viewer Script

Detects text selections within the PDF.js text layer, renders highlight overlays using PDF coordinate space, and attaches annotation anchors.

| | |
|---|---|
| **Inputs** | DOM selection events |
| **Outputs** | `Highlight` objects |

---

#### Sidebar (Standalone Module)

Hosts the chat UI and notes panel. The sidebar is a separate browser script loaded by `viewer.html`, not an injected overlay. It consumes document-scoped state from the viewer and storage layer, and talks to the viewer only through custom document events.

##### Component breakdown

- `sidebar.mjs`: owns sidebar state, tab switching, local drafts, and DOM rendering
- `viewer.mjs`: owns PDF selection, highlight rendering, and source-page scrolling
- `viewer.html`: provides the shared shell, toggle button, and sidebar mount point
- `chrome.storage.local`: persists document-scoped data once storage wiring is added

##### Event contracts

- `librarian:documentloaded` - viewer -> sidebar; current PDF URL and page count
- `librarian:selectioncaptured` - viewer -> sidebar; selected text context and affected pages
- `librarian:highlightschanged` - viewer -> sidebar; updated highlight list for the active document
- `librarian:sidebar:focus-highlight` - sidebar -> viewer; scroll to the source page for a highlight

##### Sidebar responsibilities

- Show the active document context without leaving the PDF page
- Surface selected text, highlights, annotations, and chat in one place
- Accept keyboard and toolbar-driven open/close actions
- Re-render when the active document, page selection, or stored state changes

##### Sidebar layout

- Docked panel on the right side of the viewer on desktop
- Collapsible to a narrow rail or hidden state when the user wants a larger reading area
- On small screens, may become an overlay panel rather than consuming permanent width
- Includes a header, active document summary, tab switcher, main content area, and footer actions

##### Sidebar tabs

- Chat: single-thread conversation for the active document
- Highlights: list of saved highlights grouped by page
- Notes: annotation editor and note list for the active document

##### Sidebar state

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

##### Sidebar behavior

- If the user selects text in the PDF and opens the sidebar, the selected text should be surfaced as chat context
- If a saved highlight is selected from the sidebar, the viewer should scroll to and visually emphasize the corresponding page region
- If no selection exists, the chat panel should fall back to recent highlights or an empty-context prompt
- Switching documents should reset transient UI state such as drafts and selected text, but keep persisted document data intact

##### Sidebar implementation constraints

- Must read and write through the shared document state model
- Must remain usable while PDF pages rerender during zoom, resize, or navigation
- Must not depend on absolute viewport coordinates for persistence
- Must not lose unsent chat drafts or note edits during ordinary viewer reflow

```ts
type AppState = {
  documentId: string
  highlights: Highlight[]
  annotations: Annotation[]
  chat: Chat           // single thread in MVP
  selectedText: string | null
}
```

---

#### Storage Layer

Implemented with `chrome.storage.local`.

```ts
type Document = {
  id: string          // SHA-256 of normalized URL (query params + fragments stripped)
  url: string         // original URL, stored for display purposes only
  highlights: Highlight[]
  annotations: Annotation[]
  chat: Chat
}
```

---

#### LLM Interface

```ts
interface LLMProvider {
  sendMessage(input: {
    prompt: string
    context?: string
  }): Promise<string>
}
```

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
  color: string
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

// A Chat is a single conversation thread scoped to one document.
// MVP supports one thread per document; multi-thread support is post-MVP.
type Chat = {
  id: string
  messages: Message[]
  createdAt: number
}
```

---

## 5. Core Features

### 5.1 Highlighting

- User selects text within the PDF.js text layer and applies a highlight
- Highlights are anchored to PDF coordinate space (page + bounding box), not DOM offsets
- Highlight overlays are re-rendered from stored coordinates on each load

> **Note:** PDF.js rebuilds its text layer DOM on zoom and resize. Coordinate-based anchoring sidesteps this entirely — overlays are redrawn from PDF-space coordinates rather than re-queried from DOM nodes.

---

### 5.2 Annotations

- Users attach notes to existing highlights
- Notes are editable after creation
- Notes persist via local storage

---

### 5.3 AI Chat (Context-Aware)

If text is selected, it is injected as context. Otherwise, recent highlights are used as a fallback (optional).

**Prompt template:**

```
Context:
{selected_text}

User:
{question}

Instructions:
Answer using the context above if relevant.
```

---

### 5.4 Sidebar UI

- Toggle visibility via toolbar icon or keyboard shortcut
- Sidebar logic lives in a separate script loaded by `viewer.html`
- Preserve sidebar open/closed state for the current session
- Expose three document-scoped views: chat, highlights, and notes
- Use custom document events to exchange state with the viewer
- Keep the sidebar independent from PDF render timing, while still reacting to selection and document lifecycle events
- Use the selected text as the highest-priority chat context when present
- Present recent highlights as secondary context when no selection exists
- Keep note editing inline and tied to a specific highlight when possible
- Provide clear affordances to jump from a sidebar item back to the source page in the PDF
- Avoid blocking the reader: sidebar interactions should not require leaving the PDF view or opening a separate window

**Acceptance criteria**

- Selecting text in the PDF updates the sidebar context in place
- Clicking a highlight in the sidebar scrolls the PDF to its page
- Toggling the sidebar does not reset the current document state
- Switching between chat, highlights, and notes preserves drafts and selection context

---

### 5.5 Persistence

- All data scoped per document using a canonical document ID (see §4 — `Document.id` is a SHA-256 hash of the normalized URL, stripping query params and fragments; local file paths are hashed as-is)
- Reload-safe — no data loss on navigation
- No backend dependency in MVP

---

## 6. Messaging System

### Viewer Script → Background

```ts
{
  type: "CREATE_HIGHLIGHT",
  payload: Highlight
}
```

### Sidebar → Background

```ts
{
  type: "SEND_MESSAGE",
  payload: {
    message: string
    context?: string // omitted when no selection/highlight context is available
  }
}
```

---

## 7. API Integration

### Provider (MVP)

OpenAI. The `LLMProvider` interface is designed to support additional providers in Phase 3 (Claude, Perplexity) without architectural changes.

### Requirements

- User supplies their own API key
- Keys stored locally — no server proxy in MVP
- Provider abstracted behind `LLMProvider` interface for easy swapping

---

## 8. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Highlight render time | < 50ms |
| Chat response latency | Provider-dependent |
| API key storage | Stored locally; transmitted only to the user's chosen LLM provider, never to extension servers |
| PDF.js text layer availability | Highlights must not render before text layer is ready |

---

## 9. Risks

| Risk | Description | Mitigation |
|---|---|---|
| PDF redirect reliability | `declarativeNetRequest` rules must intercept all PDF navigations, including downloads and inline embeds | Test across navigation entry points; for cases DNR cannot cover (e.g., certain blob URLs), scope explicitly as a known limitation rather than falling back to `webRequest`, which MV3 does not support for blocking redirects |
| Text layer timing | PDF.js text layer renders asynchronously — highlights drawn too early will have no targets | Gate highlight rendering on PDF.js `textlayerrendered` event |
| Zoom / resize reflow | PDF.js rebuilds text layer DOM on zoom changes | Use coordinate-based anchoring; redraw overlays on `pagerendered` |
| Context quality | Poor chunking or missing context degrades AI responses | Prefer selected text as context; tune prompt templates |

---

## 10. Milestones

### Phase 1 — MVP (Highlighting + Persistence)

- **Extension plumbing**
  - [ ] ~~Extension scaffold (Manifest v3)~~
  - [ ] ~~PDF redirect via `declarativeNetRequest`~~
- **Viewer foundation**
  - [ ] ~~PDF.js viewer page (`viewer.html`) loads the target PDF~~
  - [ ] ~~Page render lifecycle events wired (`pagerendered`, `textlayerrendered`) for gating~~
- **Highlighting core**
  - [ ] ~~Text selection detection in PDF.js text layer~~
  - [ ] ~~Convert selection → PDF-space anchor box(es)~~
  - [ ] ~~Coordinate-based highlight overlay rendering~~
  - [ ] ~~Overlay redraw on zoom/resize~~
- **Persistence**
  - [ ] Canonical document id derivation (`Document.id` as described in §4/§5.5)
  - [ ] Local storage read/write for `Document` (highlights + annotations)
  - [ ] ~~Reload-safe rehydration: render stored highlights after text layer is ready~~
- **Acceptance checks (Phase 1 “done”)**
  - [ ] ~~Open a PDF link → redirected to viewer~~
  - [ ] ~~User can select text and highlight it~~
  - [ ] ~~Highlight survives reload and zoom/resize~~

### Phase 2 — AI Chat + Sidebar UX

- **Sidebar UI**
  - [ ] ~~Sidebar shell + toggle (toolbar icon + keyboard shortcut)~~
  - [ ] ~~Sidebar module isolated from viewer rendering logic~~
  - [ ] ~~Docked desktop layout with responsive collapsed/overlay behavior~~
  - [ ] ~~Tabs: chat, highlights, notes~~
  - [ ] ~~Panels: highlights list + notes panel~~
  - [ ] ~~Annotation editing UI~~
  - [ ] ~~Jump-to-source behavior for highlights and annotations~~
  - [ ] ~~Viewer ↔ sidebar custom event contracts wired~~
- **Chat**
  - [ ] Viewer page ↔ background messaging for chat
  - [ ] OpenAI integration via `LLMProvider`
  - [ ] ~~Chat UI with message history~~
  - [ ] Chat persistence (single thread per document, using `Document.chat`)
- **Acceptance checks (Phase 2 “done”)**
  - [ ] Ask a question with selected text context
  - [ ] AI response shown in sidebar
  - [ ] Chat persists across reload

### Phase 3 — Expansion

- [ ] Multi-model support (Claude, Perplexity)
- [ ] Google Docs export
- [ ] UX polish and keyboard shortcuts

### Phase 4 — Advanced

- [ ] Embeddings + semantic search
- [ ] Multi-document context

---

## 11. Design Constraints

- Must run entirely as a Chrome Extension (Manifest v3)
- PDFs rendered via PDF.js in an extension-controlled viewer page — Chrome's native viewer is not used
- No backend in MVP — all data stays on-device
- PDF redirect must handle all navigation entry points (links, address bar, downloads)

---

## 12. Future Architecture (Post-MVP)

Potential additions when backend is introduced:

- Vector database for semantic search
- Backend API for cloud sync
- Authentication system
- Cross-device state sharing

---

## 13. Success Criteria

### Phase 1 (MVP) is complete when:

1. ~~User can select and highlight text in a PDF~~
2. All highlights and notes persist after a page reload
3. ~~Highlights remain correctly rendered across zoom/resize~~

### Phase 2 is complete when:

1. User can ask a question about selected text via the sidebar
2. AI responds using the selected text as context
3. Chat persists after a page reload
