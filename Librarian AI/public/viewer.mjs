import {
  GlobalWorkerOptions,
  getDocument,
} from "./pdfjs/build/pdf.mjs";
import {
  EventBus,
  PDFLinkService,
  PDFViewer,
} from "./pdfjs/web/pdf_viewer.mjs";

const statusEl = document.getElementById("status");
const urlEl = document.getElementById("url");
const chromeEl = document.getElementById("chrome");
const viewerContainer = document.getElementById("viewerContainer");
const viewerEl = document.getElementById("viewer");
const messageEl = document.getElementById("message");

GlobalWorkerOptions.workerSrc = new URL(
  "./pdfjs/build/pdf.worker.mjs",
  window.location.href,
).toString();

const pageState = new Map();
const pageWaiters = new Map();
const lifecycle = {
  documentLoaded: false,
  pagesCount: 0,
  pageState,
};

const highlights = [];
const highlightLayers = new Map();
const HIGHLIGHT_COLOR_STORAGE_KEY = "librarian:highlightColor";
const HIGHLIGHT_COLOR_STYLES = {
  yellow: { background: "rgba(255, 230, 0, 0.28)" },
  teal: { background: "rgba(80, 220, 210, 0.24)" },
  coral: { background: "rgba(255, 170, 150, 0.26)" },
};

let activePdfUrl = null;
let activeHighlightsKey = null;
let saveHighlightsTimer = null;
let activeHighlightColor = readStoredHighlightColor();

window.librarianViewer = {
  lifecycle,
  highlights,
  whenPageReady(pageNumber) {
    if (isPageReady(pageNumber)) {
      return Promise.resolve(pageState.get(pageNumber));
    }

    return new Promise((resolve) => {
      const waiters = pageWaiters.get(pageNumber) ?? [];
      waiters.push(resolve);
      pageWaiters.set(pageNumber, waiters);
    });
  },
  getHighlights() {
    return highlights.slice();
  },
  getHighlightColor() {
    return activeHighlightColor;
  },
  deleteHighlight(id) {
    const index = highlights.findIndex((h) => h.id === id);
    if (index === -1) {
      return false;
    }
    const [removed] = highlights.splice(index, 1);
    scheduleSaveHighlights();
    redrawHighlightsForPage(removed.pageNumber);
    notifyHighlightsChanged();
    return true;
  },
  deleteGroup(groupId) {
    const pages = new Set();
    let removedAny = false;
    for (let i = highlights.length - 1; i >= 0; i--) {
      if (highlights[i].groupId === groupId) {
        pages.add(highlights[i].pageNumber);
        highlights.splice(i, 1);
        removedAny = true;
      }
    }
    if (removedAny) {
      scheduleSaveHighlights();
      for (const pageNumber of pages) {
        redrawHighlightsForPage(pageNumber);
      }
      notifyHighlightsChanged();
    }
    return removedAny;
  },
  clearHighlights() {
    if (!highlights.length) {
      return;
    }
    const pages = new Set(highlights.map((h) => h.pageNumber));
    highlights.length = 0;
    scheduleSaveHighlights();
    for (const pageNumber of pages) {
      redrawHighlightsForPage(pageNumber);
    }
    notifyHighlightsChanged();
  },
  scrollToHighlight(id) {
    const record = highlights.find((h) => h.id === id);
    if (!record) {
      return false;
    }
    void window.librarianViewer
      .whenPageReady(record.pageNumber)
      .then(() => {
        const pageEl = document.querySelector(`.page[data-page-number="${record.pageNumber}"]`);
        if (!pageEl) {
          return;
        }

        // Ensure highlight geometry is up to date before resolving the range.
        redrawHighlightsForPage(record.pageNumber);

        const index = buildPageTextIndex(pageEl);
        if (!index) {
          pageEl.scrollIntoView({ block: "center" });
          return;
        }

        const normalized = normalizeWithMaps(index.rawText);
        const range = resolveHighlightToRange(index, normalized, record);
        if (!range) {
          pageEl.scrollIntoView({ block: "center" });
          return;
        }

        scrollRangeIntoView(range);
      })
      .catch(() => {
        // noop
      });
    return true;
  },
};

boot().catch((error) => {
  console.error("[Librarian AI] viewer boot failed", error);
  updateStatus("Failed to load PDF");
  showMessage(formatErrorMessage(error), "error");
});

async function boot() {
  const pdfUrl = await parsePdfUrl();
  activePdfUrl = pdfUrl;
  activeHighlightsKey = highlightsStorageKey(pdfUrl);
  try {
    sessionStorage.setItem("librarian:lastPdfUrl", pdfUrl);
  } catch {
    // ignore
  }
  void cacheLastPdfUrlForViewerTab(pdfUrl);
  urlEl.textContent = pdfUrl;
  updateStatus("Loading PDF");
  console.log("pdfUrl", pdfUrl);
  syncChromeHeight();
  new ResizeObserver(syncChromeHeight).observe(chromeEl);

  await loadHighlightsForPdf(pdfUrl);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const pdfViewer = new PDFViewer({
    container: viewerContainer,
    viewer: viewerEl,
    eventBus,
    linkService,
    textLayerMode: 1,
    removePageBorders: false,
  });

  bindLifecycleEvents(eventBus);
  bindHighlighting();
  bindHighlightResizeRedraw();
  bindHighlightInteractions();
  bindSidebarEvents();
  linkService.setViewer(pdfViewer);

  const documentSource = await createDocumentSource(pdfUrl);
  const loadingTask = getDocument({
    ...documentSource,
    cMapUrl: new URL("./pdfjs/cmaps/", window.location.href).toString(),
    cMapPacked: true,
    standardFontDataUrl: new URL(
      "./pdfjs/standard_fonts/",
      window.location.href,
    ).toString(),
  });

  const pdfDocument = await loadingTask.promise; 
  lifecycle.documentLoaded = true;
  lifecycle.pagesCount = pdfDocument.numPages;
  updateStatus(`Rendering ${pdfDocument.numPages} page${pdfDocument.numPages === 1 ? "" : "s"}`);

  console.log("pdfDocument", pdfDocument);

  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument);

  document.dispatchEvent(
    new CustomEvent("librarian:documentloaded", {
      detail: { pagesCount: pdfDocument.numPages, url: pdfUrl },
    }),
  );

  try {
    history.replaceState({ pdfUrl }, "", location.pathname + location.search);
  } catch {
    // Ignore replaceState failures inside the extension page.
  }
}

function highlightsStorageKey(pdfUrl) {
  return `highlights:v1:${hashPdfUrl(pdfUrl)}`;
}

function hashPdfUrl(input) {
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function storageGet(key) {
  try {
    if (chrome?.storage?.local?.get) {
      const result = await chrome.storage.local.get([key]);
      return result?.[key] ?? null;
    }
  } catch (error) {
    console.warn("[Librarian AI] storageGet chrome.storage failed", error);
  }

  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn("[Librarian AI] storageGet localStorage failed", error);
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
    console.warn("[Librarian AI] storageSet chrome.storage failed", error);
  }

  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("[Librarian AI] storageSet localStorage failed", error);
  }
}

function isValidHighlightRecord(record) {
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.groupId === "string" &&
      Number.isFinite(record.pageNumber) &&
      typeof record.exact === "string" &&
      typeof record.prefix === "string" &&
      typeof record.suffix === "string" &&
      Number.isFinite(record.createdAt),
  );
}

async function loadHighlightsForPdf(pdfUrl) {
  const key = highlightsStorageKey(pdfUrl);
  const blob = await storageGet(key);
  const records = blob?.highlights;
  highlights.length = 0;

  if (Array.isArray(records)) {
    for (const record of records) {
      if (isValidHighlightRecord(record)) {
        highlights.push(record);
      }
    }
  }
}

function scheduleSaveHighlights() {
  if (!activeHighlightsKey || !activePdfUrl) {
    return;
  }

  if (saveHighlightsTimer) {
    clearTimeout(saveHighlightsTimer);
  }

  saveHighlightsTimer = setTimeout(() => {
    void storageSet(activeHighlightsKey, {
      version: 1,
      pdfUrl: activePdfUrl,
      updatedAt: Date.now(),
      highlights: highlights.slice(),
    });
  }, 250);
}

async function getViewerTabId() {
  try {
    if (!chrome?.tabs?.getCurrent) {
      return null;
    }
    const tab = await new Promise((resolve) => chrome.tabs.getCurrent(resolve));
    return typeof tab?.id === "number" ? tab.id : null;
  } catch {
    return null;
  }
}

function viewerTabPdfUrlKey(tabId) {
  return `viewer:lastPdfUrl:${tabId}`;
}

async function cacheLastPdfUrlForViewerTab(pdfUrl) {
  const tabId = await getViewerTabId();
  if (tabId == null) {
    return;
  }

  const key = viewerTabPdfUrlKey(tabId);
  const value = { pdfUrl, updatedAt: Date.now() };
  try {
    if (chrome?.storage?.session?.set) {
      await chrome.storage.session.set({ [key]: value });
      return;
    }
  } catch {
    // ignore
  }

  try {
    if (chrome?.storage?.local?.set) {
      await chrome.storage.local.set({ [key]: value });
    }
  } catch {
    // ignore
  }
}

async function readLastPdfUrlForViewerTab() {
  const tabId = await getViewerTabId();
  if (tabId == null) {
    return null;
  }

  const key = viewerTabPdfUrlKey(tabId);
  try {
    if (chrome?.storage?.session?.get) {
      const result = await chrome.storage.session.get([key]);
      const url = result?.[key]?.pdfUrl;
      if (typeof url === "string" && url) {
        return url;
      }
    }
  } catch {
    // ignore
  }

  try {
    if (chrome?.storage?.local?.get) {
      const result = await chrome.storage.local.get([key]);
      const url = result?.[key]?.pdfUrl;
      if (typeof url === "string" && url) {
        return url;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

async function createDocumentSource(pdfUrl) {
  const pdfData = await fetchPdfBytes(pdfUrl);
  if (pdfData) {
    return { data: pdfData };
  }

  return { url: pdfUrl };
}

async function fetchPdfBytes(pdfUrl) {
  const isFileUrl = pdfUrl.startsWith("file:");
  if (isFileUrl && chrome.extension?.isAllowedFileSchemeAccess) {
    const allowed = await new Promise((resolve) => {
      chrome.extension.isAllowedFileSchemeAccess((value) => resolve(value));
    });

    if (!allowed) {
      throw new Error(
        "Local PDF access is disabled for this extension. Turn on 'Allow access to file URLs' in chrome://extensions.",
      );
    }
  }

  try {
    const response = await fetch(pdfUrl, { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (isFileUrl) {
      throw new Error(
        "Could not read the local PDF. Enable 'Allow access to file URLs' for the extension, then reload the PDF.",
      );
    }

    console.warn("[Librarian AI] fetchPdfBytes fell back to PDF.js URL loading", error);
    return null;
  }
}

function bindLifecycleEvents(eventBus) {
  eventBus.on("pagesinit", () => {
    updateStatus("Viewer initialized");
    document.dispatchEvent(new CustomEvent("librarian:pagesinit"));
  });

  eventBus.on("pagerendered", (event) => {
    const state = getOrCreatePageState(event.pageNumber);
    state.pageRendered = true;
    state.cssTransform = Boolean(event.cssTransform);
    state.timestamp = Date.now();

    updateStatus(`Page ${event.pageNumber} rendered`);
    document.dispatchEvent(
      new CustomEvent("librarian:pagerendered", {
        detail: sanitizeLifecycleEvent(event),
      }),
    );

    maybeResolvePageReady(event.pageNumber);
  });

  eventBus.on("textlayerrendered", (event) => {
    const state = getOrCreatePageState(event.pageNumber);
    state.textLayerRendered = !event.error;
    state.textLayerError = event.error ? String(event.error) : null;
    state.timestamp = Date.now();

    updateStatus(
      event.error
        ? `Text layer failed on page ${event.pageNumber}`
        : `Text layer ready on page ${event.pageNumber}`,
    );

    document.dispatchEvent(
      new CustomEvent("librarian:textlayerrendered", {
        detail: sanitizeLifecycleEvent(event),
      }),
    );

    maybeResolvePageReady(event.pageNumber);
  });

  eventBus.on("scalechanging", () => {
    scheduleRedrawAllHighlightPages();
  });

  eventBus.on("rotationchanging", () => {
    scheduleRedrawAllHighlightPages();
  });
}

function bindHighlighting() {
  document.addEventListener("mouseup", () => {
    // Let the browser finalize selection before reading it.
    queueMicrotask(() => {
      const captured = captureHighlightsFromSelection();
      if (!captured?.records?.length) {
        return;
      }

      for (const record of captured.records) {
        highlights.push(record);
      }
      scheduleSaveHighlights();

      document.dispatchEvent(
        new CustomEvent("librarian:selectioncaptured", {
          detail: {
            selectedText: captured.selectedText,
            pageNumbers: [...new Set(captured.records.map((h) => h.pageNumber))],
            groupId: captured.records[0]?.groupId ?? null,
          },
        }),
      );

      document.dispatchEvent(
        new CustomEvent("librarian:highlightschanged", {
          detail: { highlights: highlights.slice() },
        }),
      );

      const pagesToRedraw = new Set(captured.records.map((h) => h.pageNumber));
      for (const pageNumber of pagesToRedraw) {
        redrawHighlightsForPage(pageNumber);
      }
    });
  });

  document.addEventListener("librarian:pageready", (event) => {
    const pageNumber = event?.detail?.pageNumber;
    if (typeof pageNumber === "number") {
      redrawHighlightsForPage(pageNumber);
    }
  });
}

let highlightRedrawTimer = null;

function scheduleRedrawAllHighlightPages() {
  if (highlightRedrawTimer != null) {
    clearTimeout(highlightRedrawTimer);
  }
  highlightRedrawTimer = setTimeout(() => {
    highlightRedrawTimer = null;
    const pages = [...new Set(highlights.map((h) => h.pageNumber))];
    for (const pageNumber of pages) {
      redrawHighlightsForPage(pageNumber);
    }
  }, 100);
}

function bindHighlightResizeRedraw() {
  window.addEventListener("resize", scheduleRedrawAllHighlightPages);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleRedrawAllHighlightPages);
  }
}

function bindHighlightInteractions() {
  const activateHighlightFromTarget = (target) => {
    const button = target?.closest?.(".librarianHighlightHitTarget");
    if (!(button instanceof HTMLElement)) {
      return null;
    }

    const pageNumber = Number(button.dataset.pageNumber);
    const highlightId = button.dataset.highlightId ?? "";
    const groupId = button.dataset.groupId ?? "";
    const color = button.dataset.color ?? "yellow";
    if (!highlightId || !Number.isFinite(pageNumber)) {
      return null;
    }

    return { pageNumber, highlightId, groupId, color };
  };

  viewerContainer.addEventListener("click", (event) => {
    const target = activateHighlightFromTarget(event.target);
    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    document.dispatchEvent(
      new CustomEvent("librarian:viewer:highlight-selected", {
        detail: target,
      }),
    );
  });

  viewerContainer.addEventListener("contextmenu", (event) => {
    const target = activateHighlightFromTarget(event.target);
    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    document.dispatchEvent(
      new CustomEvent("librarian:viewer:highlight-contextmenu", {
        detail: {
          ...target,
          clientX: event.clientX,
          clientY: event.clientY,
        },
      }),
    );
  });
}

function bindSidebarEvents() {
  document.addEventListener("librarian:sidebar:focus-highlight", (event) => {
    const pageNumber = event?.detail?.pageNumber;
    if (!Number.isFinite(pageNumber)) {
      return;
    }

    const pageEl = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
    if (!pageEl) {
      return;
    }

    pageEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    redrawHighlightsForPage(pageNumber);
  });

  document.addEventListener("librarian:sidebar:delete-highlight", (event) => {
    const detail = event?.detail ?? {};
    const highlightId = typeof detail.highlightId === "string" ? detail.highlightId : "";
    const groupId = typeof detail.groupId === "string" ? detail.groupId : "";

    if (groupId && window.librarianViewer.deleteGroup(groupId)) {
      return;
    }

    if (highlightId) {
      window.librarianViewer.deleteHighlight(highlightId);
    }
  });

  document.addEventListener("librarian:sidebar:set-highlight-color", (event) => {
    const nextColor = normalizeHighlightColor(event?.detail?.color);
    if (!nextColor || nextColor === activeHighlightColor) {
      return;
    }

    const highlightId = typeof event?.detail?.highlightId === "string" ? event.detail.highlightId : "";
    const groupId = typeof event?.detail?.groupId === "string" ? event.detail.groupId : "";

    activeHighlightColor = nextColor;
    storeHighlightColor(nextColor);

    const pages = new Set();
    let changed = false;
    if (highlightId || groupId) {
      for (const highlight of highlights) {
        const matchesGroup = groupId && highlight.groupId === groupId;
        const matchesHighlight = highlightId && highlight.id === highlightId;
        if (!matchesGroup && !matchesHighlight) {
          continue;
        }

        highlight.color = nextColor;
        pages.add(highlight.pageNumber);
        changed = true;
      }
    }

    if (changed) {
      scheduleSaveHighlights();
      for (const pageNumber of pages) {
        redrawHighlightsForPage(pageNumber);
      }
      notifyHighlightsChanged();
    }
  });
}

function captureHighlightsFromSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!range || range.collapsed) {
    return null;
  }

  const startPage = getPageElementForNode(range.startContainer);
  const endPage = getPageElementForNode(range.endContainer);
  if (!startPage || !endPage) {
    return null;
  }

  const startPageNumber = parseInt(startPage.dataset.pageNumber ?? "", 10);
  const endPageNumber = parseInt(endPage.dataset.pageNumber ?? "", 10);
  if (!Number.isFinite(startPageNumber) || !Number.isFinite(endPageNumber)) {
    return null;
  }

  const groupId = crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const pageNumbers = [];
  const minPage = Math.min(startPageNumber, endPageNumber);
  const maxPage = Math.max(startPageNumber, endPageNumber);
  for (let p = minPage; p <= maxPage; p++) {
    pageNumbers.push(p);
  }

  const records = [];
  for (const pageNumber of pageNumbers) {
    const pageEl = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
    const textLayer = pageEl?.querySelector?.(".textLayer");
    if (!pageEl || !textLayer) {
      continue;
    }

    const boundary = getTextLayerBoundaryPoints(textLayer);
    if (!boundary) {
      continue;
    }

    const pageRange = document.createRange();
    if (pageNumber === startPageNumber) {
      const startPoint = clampDomPointToTextLayer(
        textLayer,
        range.startContainer,
        range.startOffset,
        boundary.firstNode,
      );
      pageRange.setStart(startPoint.node, startPoint.offset);
    } else {
      pageRange.setStart(boundary.firstNode, 0);
    }

    if (pageNumber === endPageNumber) {
      const endPoint = clampDomPointToTextLayer(
        textLayer,
        range.endContainer,
        range.endOffset,
        boundary.firstNode,
      );
      pageRange.setEnd(endPoint.node, endPoint.offset);
    } else {
      pageRange.setEnd(boundary.lastNode, boundary.lastNode.nodeValue?.length ?? 0);
    }

    const anchored = rangeToAnchoredText(pageEl, pageRange);
    if (!anchored) {
      continue;
    }

    records.push({
      id: crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      groupId,
      pageNumber,
      exact: anchored.exact,
      prefix: anchored.prefix,
      suffix: anchored.suffix,
      createdAt: Date.now(),
      color: activeHighlightColor,
    });
  }

  if (!records.length) {
    return null;
  }

  const selectedText = selection.toString().trim();
  selection.removeAllRanges();
  return { records, selectedText };
}

function redrawHighlightsForPage(pageNumber) {
  const pageEl = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
  if (!pageEl) {
    return;
  }

  const textLayer = pageEl.querySelector(".textLayer");
  if (!textLayer) {
    return;
  }

  const layerEl = getOrCreateHighlightLayer(textLayer, pageNumber);
  ensureHighlightLayerAboveTextSpans(textLayer, layerEl);

  const visualsEl = document.createElement("div");
  visualsEl.className = "librarianHighlightVisuals";
  visualsEl.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:1";
  layerEl.replaceChildren(visualsEl);

  const anchor =
    layerEl.offsetParent?.getBoundingClientRect() ?? textLayer.getBoundingClientRect();
  const index = buildPageTextIndex(pageEl);
  if (!index) {
    return;
  }

  const normalized = normalizeWithMaps(index.rawText);
  const mergeOpts = { lineTolPx: 3, gapTolPx: 3 };
  const hitPaintQueue = [];

  for (const highlight of highlights) {
    if (highlight.pageNumber !== pageNumber) {
      continue;
    }

    const range = resolveHighlightToRange(index, normalized, highlight);
    if (!range) {
      continue;
    }

    const mergedRects = mergeClientRects([...range.getClientRects()], mergeOpts);
    if (!mergedRects.length) {
      continue;
    }

    const color = normalizeHighlightColor(highlight.color);
    const style = getHighlightStyle(color);
    for (const rect of mergedRects) {
      appendHighlightVisualRect(visualsEl, rect, anchor, style, color);
    }
    hitPaintQueue.push({ highlight, mergedRects });
  }

  const hitLayer = ensureHighlightHitLayer(layerEl);
  hitLayer.replaceChildren();
  for (const { highlight, mergedRects } of hitPaintQueue) {
    appendHighlightHitTargets(hitLayer, highlight, mergedRects, anchor);
  }
}

function appendHighlightVisualRect(visualsEl, rectViewport, anchorViewport, style, color) {
  const left = rectViewport.left - anchorViewport.left;
  const top = rectViewport.top - anchorViewport.top;
  const width = rectViewport.width;
  const height = rectViewport.height;
  if (width <= 0 || height <= 0) {
    return;
  }

  const el = document.createElement("div");
  el.className = `librarianHighlightRect is-${color}`;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.style.background = style.background;
  visualsEl.appendChild(el);
}

function resolveHighlightToRange(pageIndex, normalized, highlight) {
  const { norm, normToRaw } = normalized;
  const fullNeedle = `${highlight.prefix ?? ""}${highlight.exact}${highlight.suffix ?? ""}`;
  let matchStart = fullNeedle ? norm.indexOf(fullNeedle) : -1;
  if (matchStart !== -1) {
    matchStart += (highlight.prefix ?? "").length;
  } else {
    matchStart = norm.indexOf(highlight.exact);
  }

  if (matchStart === -1) {
    return null;
  }

  const matchEnd = matchStart + highlight.exact.length;
  const rawStart = normIndexToRawOffset(normToRaw, matchStart, pageIndex.rawText.length);
  const rawEnd = normIndexToRawOffset(normToRaw, matchEnd, pageIndex.rawText.length);

  const startPoint = rawOffsetToDomPoint(pageIndex, rawStart);
  const endPoint = rawOffsetToDomPoint(pageIndex, rawEnd);
  if (!startPoint || !endPoint) {
    return null;
  }

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function normIndexToRawOffset(normToRaw, normIndex, rawLength) {
  if (normIndex <= 0) {
    return 0;
  }

  if (normIndex >= normToRaw.length) {
    return rawLength;
  }

  const raw = normToRaw[normIndex];
  return typeof raw === "number" ? raw : rawLength;
}

function getTextLayerBoundaryPoints(textLayerEl) {
  const walker = document.createTreeWalker(textLayerEl, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  if (!first) {
    return null;
  }
  let last = first;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    last = current;
  }
  return { firstNode: first, lastNode: last };
}

function rangeToAnchoredText(pageEl, range) {
  const textLayer = pageEl.querySelector(".textLayer");
  if (!textLayer) {
    return null;
  }

  if (!textLayer.contains(range.commonAncestorContainer)) {
    return null;
  }

  const index = buildPageTextIndex(pageEl);
  if (!index) {
    return null;
  }

  const rawStart = getRawOffsetForDomPoint(index, range.startContainer, range.startOffset);
  const rawEnd = getRawOffsetForDomPoint(index, range.endContainer, range.endOffset);
  if (rawStart == null || rawEnd == null || rawEnd <= rawStart) {
    return null;
  }

  const { norm, rawToNorm } = normalizeWithMaps(index.rawText);
  const normStart = rawToNorm[rawStart] ?? 0;
  const normEnd = rawToNorm[rawEnd] ?? norm.length;
  if (normEnd <= normStart) {
    return null;
  }

  const CONTEXT = 32;
  const exact = norm.slice(normStart, normEnd);
  const prefix = norm.slice(Math.max(0, normStart - CONTEXT), normStart);
  const suffix = norm.slice(normEnd, Math.min(norm.length, normEnd + CONTEXT));
  return { exact, prefix, suffix };
}

function scrollRangeIntoView(range) {
  const rect = range.getClientRects()?.[0] ?? range.getBoundingClientRect();
  if (!rect || !Number.isFinite(rect.top)) {
    return;
  }

  const containerRect = viewerContainer.getBoundingClientRect();
  const currentTop = viewerContainer.scrollTop;
  const targetTop = rect.top - containerRect.top + currentTop - containerRect.height / 2;
  viewerContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
}

function ensureHighlightHitLayer(layerEl) {
  let hitLayer = layerEl.querySelector(".librarianHighlightHitLayer");
  if (!hitLayer) {
    hitLayer = document.createElement("div");
    hitLayer.className = "librarianHighlightHitLayer";
    hitLayer.setAttribute("aria-hidden", "true");
    hitLayer.style.position = "absolute";
    hitLayer.style.inset = "0";
    hitLayer.style.pointerEvents = "none";
    hitLayer.style.zIndex = "2";
    layerEl.appendChild(hitLayer);
  }
  return hitLayer;
}

function appendHighlightHitTargets(hitLayer, highlight, rects, anchorViewport) {
  const color = normalizeHighlightColor(highlight.color);

  for (const rect of rects) {
    const left = rect.left - anchorViewport.left;
    const top = rect.top - anchorViewport.top;
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) {
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = `librarianHighlightHitTarget is-${color}`;
    button.tabIndex = -1;
    button.dataset.highlightId = highlight.id;
    button.dataset.groupId = highlight.groupId ?? "";
    button.dataset.pageNumber = String(highlight.pageNumber);
    button.dataset.color = color;
    button.setAttribute("aria-label", `Highlight: ${highlight.exact}`);
    button.style.position = "absolute";
    button.style.pointerEvents = "auto";
    button.style.background = "transparent";
    button.style.border = "0";
    button.style.padding = "0";
    button.style.margin = "0";
    button.style.opacity = "0";
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    button.style.width = `${width}px`;
    button.style.height = `${height}px`;
    hitLayer.appendChild(button);
  }
}

function getHighlightStyle(color) {
  const normalized = normalizeHighlightColor(color);
  return HIGHLIGHT_COLOR_STYLES[normalized] ?? HIGHLIGHT_COLOR_STYLES.yellow;
}

function normalizeHighlightColor(color) {
  return Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLOR_STYLES, color) ? color : "yellow";
}

function readStoredHighlightColor() {
  try {
    const stored = sessionStorage.getItem(HIGHLIGHT_COLOR_STORAGE_KEY);
    return normalizeHighlightColor(stored);
  } catch {
    return "yellow";
  }
}

function storeHighlightColor(color) {
  try {
    sessionStorage.setItem(HIGHLIGHT_COLOR_STORAGE_KEY, normalizeHighlightColor(color));
  } catch {
    // ignore
  }
}

function notifyHighlightsChanged() {
  document.dispatchEvent(
    new CustomEvent("librarian:highlightschanged", {
      detail: { highlights: highlights.slice() },
    }),
  );
}

function mergeClientRects(rects, { lineTolPx = 2, gapTolPx = 2 } = {}) {
  const normalized = [];
  for (const rect of rects) {
    const left = rect.left;
    const top = rect.top;
    const right = rect.right;
    const bottom = rect.bottom;
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) {
      continue;
    }

    normalized.push({ left, top, right, bottom, width, height });
  }

  if (!normalized.length) {
    return [];
  }

  normalized.sort((a, b) => (a.top - b.top) || (a.left - b.left));

  const lines = [];
  for (const rect of normalized) {
    let line = lines[lines.length - 1];
    if (
      !line ||
      (Math.abs(rect.top - line.top) > lineTolPx &&
        Math.abs(rect.bottom - line.bottom) > lineTolPx)
    ) {
      line = {
        top: rect.top,
        bottom: rect.bottom,
        rects: [],
      };
      lines.push(line);
    } else {
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    }
    line.rects.push(rect);
  }

  const mergedRects = [];
  for (const line of lines) {
    line.rects.sort((a, b) => a.left - b.left);

    let current = null;
    for (const rect of line.rects) {
      if (!current) {
        current = { ...rect };
        continue;
      }

      if (rect.left <= current.right + gapTolPx) {
        current.left = Math.min(current.left, rect.left);
        current.top = Math.min(current.top, rect.top);
        current.right = Math.max(current.right, rect.right);
        current.bottom = Math.max(current.bottom, rect.bottom);
        current.width = current.right - current.left;
        current.height = current.bottom - current.top;
        continue;
      }

      mergedRects.push(current);
      current = { ...rect };
    }

    if (current) {
      mergedRects.push(current);
    }
  }

  return mergedRects;
}

function ensureHighlightLayerAboveTextSpans(textLayerEl, layerEl) {
  if (layerEl.parentElement === textLayerEl && textLayerEl.lastElementChild !== layerEl) {
    textLayerEl.appendChild(layerEl);
  }
}

function getOrCreateHighlightLayer(textLayerEl, pageNumber) {
  const existing = highlightLayers.get(pageNumber);
  if (existing && existing.isConnected) {
    return existing;
  }

  const layer = document.createElement("div");
  layer.className = "librarianHighlightLayer";
  layer.dataset.pageNumber = String(pageNumber);
  layer.style.position = "absolute";
  layer.style.inset = "0";
  layer.style.zIndex = "2";
  layer.style.pointerEvents = "none";
  textLayerEl.appendChild(layer);
  highlightLayers.set(pageNumber, layer);
  return layer;
}

function getPageElementForNode(node) {
  const el = node instanceof Element ? node : node?.parentElement;
  return el?.closest?.(".page") ?? null;
}

// Ensure a DOM point stays within a specific text layer.
function clampDomPointToTextLayer(textLayer, node, offset, fallbackNode) {
  if (textLayer.contains(node)) {
    return { node, offset };
  }
  return { node: fallbackNode, offset: 0 };
}

function buildPageTextIndex(pageEl) {
  const textLayer = pageEl.querySelector(".textLayer");
  if (!textLayer) {
    return null;
  }

  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  const nodes = [];
  const nodeStarts = new Map();
  let rawText = "";
  let lastWasSpace = true;

  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const value = current.nodeValue ?? "";
    if (!value) {
      continue;
    }

    if (!lastWasSpace) {
      rawText += " ";
      lastWasSpace = true;
    }

    const start = rawText.length;
    rawText += value;
    const end = rawText.length;
    nodes.push({ node: current, start, end });
    nodeStarts.set(current, start);
    lastWasSpace = /\s$/.test(value);
  }

  if (!rawText.trim()) {
    return null;
  }

  return { rawText, nodes, nodeStarts };
}

function normalizeWithMaps(raw) {
  const normToRaw = [];
  const rawToNorm = new Array(raw.length + 1);
  let norm = "";
  let normIndex = 0;
  let lastWasSpace = true;

  for (let rawIndex = 0; rawIndex < raw.length; rawIndex++) {
    rawToNorm[rawIndex] = normIndex;
    const ch = raw[rawIndex];
    const isSpace = /\s/.test(ch);

    if (isSpace) {
      if (lastWasSpace) {
        continue;
      }
      lastWasSpace = true;
      normToRaw[normIndex] = rawIndex;
      norm += " ";
      normIndex += 1;
      continue;
    }

    lastWasSpace = false;
    normToRaw[normIndex] = rawIndex;
    norm += ch;
    normIndex += 1;
  }

  rawToNorm[raw.length] = normIndex;
  return { norm, normToRaw, rawToNorm };
}

function getRawOffsetForDomPoint(pageIndex, container, offset) {
  if (!(container instanceof Node)) {
    return null;
  }

  if (container.nodeType === Node.TEXT_NODE) {
    const start = pageIndex.nodeStarts.get(container);
    if (typeof start !== "number") {
      return null;
    }
    return start + offset;
  }

  const child = container.childNodes?.[offset] ?? null;
  if (!child) {
    return null;
  }

  const text = child.nodeType === Node.TEXT_NODE ? child : child.firstChild;
  if (text?.nodeType !== Node.TEXT_NODE) {
    return null;
  }

  const start = pageIndex.nodeStarts.get(text);
  if (typeof start !== "number") {
    return null;
  }
  return start;
}

function rawOffsetToDomPoint(pageIndex, rawOffset) {
  const nodes = pageIndex.nodes;
  if (!nodes.length) {
    return null;
  }

  let clamped = Math.max(0, Math.min(rawOffset, pageIndex.rawText.length));

  // Move clamped offset onto a mapped node if it lands in synthetic whitespace.
  const findAt = (pos) => nodes.find((entry) => pos >= entry.start && pos <= entry.end);
  let entry = findAt(clamped);
  if (!entry) {
    // Try nudging to nearest node boundary.
    for (let delta = 1; delta < 8 && !entry; delta++) {
      entry = findAt(clamped - delta) || findAt(clamped + delta);
    }
  }

  if (!entry) {
    return null;
  }

  const offset = Math.max(0, Math.min(entry.end - entry.start, clamped - entry.start));
  return { node: entry.node, offset };
}

async function parsePdfUrl() {
  const raw = window.location.hash.length > 1 ? window.location.hash.slice(1) : "";
  if (raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new Error("Could not decode document URL from the address.");
    }
  }

  // Fallback for reloads after replaceState removed the hash.
  const stateUrl = history.state?.pdfUrl;
  if (typeof stateUrl === "string" && stateUrl) {
    return stateUrl;
  }

  try {
    const cached = sessionStorage.getItem("librarian:lastPdfUrl");
    if (cached) {
      return cached;
    }
  } catch {
    // ignore
  }

  const tabCached = await readLastPdfUrlForViewerTab();
  if (tabCached) {
    return tabCached;
  }

  throw new Error("No document URL. Open a link to an http(s) or file .pdf.");
}

function getOrCreatePageState(pageNumber) {
  const current = pageState.get(pageNumber);
  if (current) {
    return current;
  }

  const next = {
    pageNumber,
    pageRendered: false,
    textLayerRendered: false,
    textLayerError: null,
    cssTransform: false,
    timestamp: null,
  };
  pageState.set(pageNumber, next);
  return next;
}

function isPageReady(pageNumber) {
  const state = pageState.get(pageNumber);
  return Boolean(state?.pageRendered && state?.textLayerRendered);
}

function maybeResolvePageReady(pageNumber) {
  if (!isPageReady(pageNumber)) {
    return;
  }

  const state = pageState.get(pageNumber);
  document.dispatchEvent(
    new CustomEvent("librarian:pageready", {
      detail: { ...state },
    }),
  );

  const waiters = pageWaiters.get(pageNumber) ?? [];
  for (const resolve of waiters) {
    resolve(state);
  }
  pageWaiters.delete(pageNumber);
}

function sanitizeLifecycleEvent(event) {
  return {
    pageNumber: event.pageNumber,
    cssTransform: Boolean(event.cssTransform),
    error: event.error ? String(event.error) : null,
    source: event.source?.constructor?.name ?? null,
  };
}

function updateStatus(message) {
  statusEl.textContent = message;
}

function syncChromeHeight() {
  document.documentElement.style.setProperty(
    "--chrome-height",
    `${chromeEl.getBoundingClientRect().height}px`,
  );
}

function showMessage(message, tone = "info") {
  messageEl.hidden = false;
  messageEl.dataset.tone = tone;
  messageEl.textContent = message;
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? "Unknown viewer error");
}
