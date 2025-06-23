import { jsx as _jsx } from "react/jsx-runtime";
const Popup = () => {
    const handleHighlight = () => {
        // Use chrome.* for Chrome extensions
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs[0]?.id;
            if (tabId !== undefined) {
                chrome.tabs.sendMessage(tabId, { action: "enableHighlighting" });
            }
        });
    };
    return (_jsx("div", { className: "popup-container", children: _jsx("button", { id: "highlightBtn", onClick: handleHighlight, children: "Highlight" }) }));
};
export default Popup;
