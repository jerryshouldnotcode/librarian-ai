import { useEffect, useState, type FC } from "react";

/** Top-level navigations the background script redirects into the extension viewer. */
const PDF_TOP_LEVEL_URL_RE =
  /^((https?:\/\/.+\.pdf(\?.*)?)|(file:\/\/.*\.pdf)|(https?:\/\/arxiv\.org\/pdf\/.*))$/i;

function viewerBaseUrl(): string {
  return chrome.runtime.getURL("viewer.html");
}

function isViewerTab(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const base = viewerBaseUrl();
  return url === base || url.startsWith(`${base}#`) || url.startsWith(`${base}?`);
}

function isLikelyPdfTab(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  return PDF_TOP_LEVEL_URL_RE.test(url);
}

const Popup: FC = () => {
  const [tabUrl, setTabUrl] = useState<string | undefined>();
  const [tabId, setTabId] = useState<number | undefined>();

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      setTabUrl(tab?.url);
      setTabId(tab?.id);
    });
  }, []);

  const openReaderInNewTab = () => {
    chrome.tabs.create({ url: viewerBaseUrl() });
  };

  const openThisPdfInReader = () => {
    if (tabUrl === undefined || tabId === undefined) {
      return;
    }
    chrome.tabs.update(tabId, {
      url: `${viewerBaseUrl()}#${encodeURIComponent(tabUrl)}`,
    });
  };

  const inViewer = isViewerTab(tabUrl);
  const showOpenPdf = isLikelyPdfTab(tabUrl) && !inViewer && tabId !== undefined;

  return (
    <main className="popupShell">
      <section className="popupHero">
        <div className="popupEyebrow">Librarian AI</div>
        <h1 className="popupTitle">Read in the viewer. Annotate in place.</h1>
        <p className="popupLead">
          PDF reading, highlight actions, notes, and chat live inside the extension-controlled reader.
          The popup simply routes the current tab into that workspace.
        </p>
      </section>

      <section className="popupStatusGrid" aria-label="Current tab state">
        <div className="popupStatusCard">
          <div className="popupStatusLabel">Mode</div>
          <div className="popupStatusValue">{inViewer ? "Reader open" : "Shell"}</div>
        </div>
        <div className="popupStatusCard">
          <div className="popupStatusLabel">Source</div>
          <div className="popupStatusValue">{showOpenPdf ? "PDF detected" : "No PDF detected"}</div>
        </div>
      </section>

      <section className="popupActions" aria-label="Open reader actions">
        {showOpenPdf && (
          <button type="button" className="popupButton popupButtonPrimary" onClick={openThisPdfInReader}>
            Open this PDF in Librarian
          </button>
        )}

        <button
          type="button"
          className={`popupButton ${showOpenPdf ? "popupButtonSecondary" : "popupButtonPrimary"}`}
          onClick={openReaderInNewTab}
        >
          Open reader in new tab
        </button>
      </section>

      <section className="popupNotes" aria-label="Design notes">
        <div className="popupNote">
          <span>Reader-first</span>
          <p>The PDF remains visible while the sidebar handles annotations and context.</p>
        </div>
        <div className="popupNote">
          <span>Local by default</span>
          <p>Highlights and notes stay document-scoped on the device until sync is introduced.</p>
        </div>
      </section>

      {inViewer && <p className="popupFooter">This tab is already running the reader.</p>}
    </main>
  );
};

export default Popup;
