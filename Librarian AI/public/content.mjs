import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');

// detecting if file is a pdf
function isPDFpage() {
    const url = window.location.href;
    return url.endsWith('.pdf') ||
        document.contentType === 'application/pdf';
}

// Global variable for highlight layer
let highlightLayer;
let pdfSetupDone = false; // Track if setup is done

// Function to create a highlight
function createHighlight(selection) {
    if (!highlightLayer) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const highlight = document.createElement('div');
    highlight.className = 'highlight';
    highlight.style.position = 'absolute';
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlight.style.backgroundColor = 'yellow';
    highlight.style.opacity = '0.3';
    highlight.style.pointerEvents = 'none';
    highlight.style.zIndex = '1000';
    highlightLayer.appendChild(highlight);
    selection.removeAllRanges();
    console.log('Highlight created!', rect);
}

// Function to clear all highlights
function clearHighlights() {
    document.querySelectorAll('.highlight').forEach(el => el.remove());
}

// Function to set up PDF viewer and highlight overlay (only runs once)
function setupPdfAndHighlightOverlay() {
    if (pdfSetupDone || !isPDFpage()) return;
    pdfSetupDone = true;

    // create a link element for the CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = browser.runtime.getURL('content.css'); 
    document.head.appendChild(link);

    // main container for the pdf and highlights
    const pdfContainer = document.createElement('div');
    pdfContainer.className = 'pdf-container';

    // container for PDF.js loading
    const pdfViewer = document.createElement('div');
    pdfViewer.className = 'pdf-viewer';

    // container for highlights
    highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';

    // append the highlight layer and viewer to the main container
    pdfContainer.appendChild(pdfViewer);
    pdfContainer.appendChild(highlightLayer);

    // add both to the body
    document.body.appendChild(pdfContainer);

    // Load the PDF using PDF.js
    const url = window.location.href;
    const loadingTask = getDocument(url); // Use the current URL
    loadingTask.promise.then(pdf => {
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            pdf.getPage(pageNum).then(page => {
                const viewport = page.getViewport({ scale: 1.0 });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                pdfViewer.appendChild(canvas);
                const renderContext = {
                    canvasContext: context,
                    viewport: viewport
                };
                page.render(renderContext);
            });
        }
    });

    // Add event listener for text selection
    document.addEventListener('mouseup', () => {
        const selection = window.getSelection();
        if (selection.toString().length > 0) {
            createHighlight(selection);
        }
    });
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "enableHighlighting") {
        setupPdfAndHighlightOverlay();
    }
    if (message.action === "clearHighlights") {
        clearHighlights();
    }
});

console.log('Content script loaded!');

// Optionally, run setup on initial load if you want highlights to always be available on PDF pages
setupPdfAndHighlightOverlay();

/* Logic: instead of having the PDF file re-render highlights
   every time a change is made to the PDF file (e.g., zooming in and out),
   highlights will be made on an overlay that is appended to the PDF independently.
*/



