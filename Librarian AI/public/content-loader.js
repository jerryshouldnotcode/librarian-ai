(async () => {
  try {
    await import(chrome.runtime.getURL('content.mjs'));
  } catch (err) {
    console.error('Failed to load content.mjs', err);
  }
})();
