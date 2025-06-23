const Popup: React.FC = () => {
  const handleHighlight = () => {
    // Use chrome.* for Chrome extensions
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) {
        chrome.tabs.sendMessage(tabId, { action: "enableHighlighting" });
      }
    });
  };

  return (
    <div className="popup-container">
      <button id="highlightBtn" onClick={handleHighlight}>
        Highlight
      </button>
    </div>
  )
}

export default Popup 