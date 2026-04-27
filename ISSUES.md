# Issues (tracking)

## Fixed

### Viewer refresh loses PDF URL
- **Symptom**: Refreshing `viewer.html` throws `No document URL. Open a link to an http(s) or file .pdf.` and the PDF is no longer loaded.
- **Cause**: The viewer loads the PDF URL from `location.hash`, but then removes the hash via `history.replaceState(...)`, so subsequent reloads have no URL.
- **Fix**: Store the active PDF URL in `history.state` and fall back to it when the hash is empty. For robustness across refresh/extension reload scenarios where page state/storage may be empty, also persist a per-viewer-tab “last PDF URL” in `chrome.storage` (keyed by tab id) and fall back to that as well.
- **Note**: Make sure the *packaged* `viewer.mjs` served by the extension (e.g. `chrome-extension://…/viewer.mjs`) includes the caching code; editing only the source file won’t affect runtime if the build/copy step isn’t applied.

