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
};

boot().catch((error) => {
  console.error("[Librarian AI] viewer boot failed", error);
  updateStatus("Failed to load PDF");
  showMessage(formatErrorMessage(error), "error");
});

async function boot() {
  const pdfUrl = parsePdfUrl();
  urlEl.textContent = pdfUrl;
  updateStatus("Loading PDF");
  console.log("pdfUrl", pdfUrl);
  syncChromeHeight();
  new ResizeObserver(syncChromeHeight).observe(chromeEl);

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
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // Ignore replaceState failures inside the extension page.
  }
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
}

function bindHighlighting() {
  document.addEventListener("mouseup", () => {
    // Let the browser finalize selection before reading it.
    queueMicrotask(() => {
      const highlight = captureHighlightFromSelection();
      if (!highlight) {
        return;
      }

      highlights.push(highlight);
      redrawHighlightsForPage(highlight.pageNumber);
    });
  });

  document.addEventListener("librarian:pageready", (event) => {
    const pageNumber = event?.detail?.pageNumber;
    if (typeof pageNumber === "number") {
      redrawHighlightsForPage(pageNumber);
    }
  });
}

function captureHighlightFromSelection() {
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
  if (!startPage || startPage !== endPage) {
    return null;
  }

  const textLayer = startPage.querySelector(".textLayer");
  if (!textLayer) {
    return null;
  }

  if (!textLayer.contains(range.commonAncestorContainer)) {
    return null;
  }

  const pageNumber = parseInt(startPage.dataset.pageNumber ?? "", 10);
  if (!Number.isFinite(pageNumber)) {
    return null;
  }

  const index = buildPageTextIndex(startPage);
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

  selection.removeAllRanges();

  return {
    id: crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    pageNumber,
    exact,
    prefix,
    suffix,
    createdAt: Date.now(),
  };
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

  const layer = getOrCreateHighlightLayer(textLayer, pageNumber);
  layer.replaceChildren();

  const index = buildPageTextIndex(pageEl);
  if (!index) {
    return;
  }

  const normalized = normalizeWithMaps(index.rawText);

  for (const highlight of highlights) {
    if (highlight.pageNumber !== pageNumber) {
      continue;
    }

    const range = resolveHighlightToRange(index, normalized, highlight);
    if (!range) {
      continue;
    }

    renderHighlightRange(textLayer, layer, range);
  }
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

function renderHighlightRange(textLayerEl, layerEl, range) {
  const textLayerRect = textLayerEl.getBoundingClientRect();
  for (const rect of range.getClientRects()) {
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    const el = document.createElement("div");
    el.className = "librarianHighlightRect";
    el.style.left = `${rect.left - textLayerRect.left}px`;
    el.style.top = `${rect.top - textLayerRect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    layerEl.appendChild(el);
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
  textLayerEl.appendChild(layer);
  highlightLayers.set(pageNumber, layer);
  return layer;
}

function getPageElementForNode(node) {
  const el = node instanceof Element ? node : node?.parentElement;
  return el?.closest?.(".page") ?? null;
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

function parsePdfUrl() {
  const raw = window.location.hash.length > 1 ? window.location.hash.slice(1) : "";
  if (!raw) {
    throw new Error("No document URL. Open a link to an http(s) or file .pdf.");
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error("Could not decode document URL from the address.");
  }
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
