import { PDFJS } from 'pdfjs-dist/build/pdf';
import { createHighlight } from './highlighter';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs';

// Set the worker source
PDFJS.GlobalWorkerOptions.workerSrc = pdfWorker; 

console.log('Content script loaded!')

// detecting if file is a pdf
function isPDFpage() {
    const url = window.location.href;
    return url.endsWith('.pdf') ||
        document.contentType === 'application/pdf';
}

/* Main logic: instead of having the PDF file re-render highlights
every time a change is made to the PDF file (e.g., zooming in and out),
highlights will be made on an overlay that is appended to the PDF 
independently.
*/

if (isPDFpage() === true){
    // create a link element for the CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';

    // to get the correct path
    link.href = browser.runtime.getURL('content.css'); 

    // append the link to the head of the document
    document.head.appendChild(link);

    // main container for the pdf and highlights
    const pdfContainer = document.createElement('div');
    pdfContainer.className = 'pdf-container';

    // container for PDF.js loading
    const pdfViewer = document.createElement('div');
    pdfViewer.className = 'pdf-viewer';

    // container for highlights
    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';

    // append the highlight layer and viewer to the main container
    pdfContainer.appendChild(pdfViewer);
    pdfContainer.appendChild(highlightLayer);

    // add both to the body
    document.body.appendChild(pdfContainer);

    // Load the PDF using PDF.js
    const loadingTask = PDFJS.getDocument(url); // Use the current URL
    loadingTask.promise.then(pdf => {
        // Render each page
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
            // Call a function from highlighter.js to create a highlight
            createHighlight(selection);
        }
    });
}
    

