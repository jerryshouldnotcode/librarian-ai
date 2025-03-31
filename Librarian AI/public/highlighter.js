console.log('Highlighter added!')

// Function to create a highlight
function createHighlight(selection) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const highlight = document.createElement('div');
    highlight.className = 'highlight'; // Add your highlight styles
    highlight.style.position = 'absolute';
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlightLayer.appendChild(highlight); // Ensure highlightLayer is accessible

    // Store highlight data if needed
    // highlights.push({ ... });
}

// Export the function if needed
export { createHighlight };