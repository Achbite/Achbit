(input) => {
  if (typeof window.find !== 'function') throw Error('Page text search is unavailable in this WebView.');
  if (input.action === 'endFind') { getSelection()?.removeAllRanges(); return { found: false }; }
  if (typeof input.text !== 'string' || !input.text) return { found: false };
  const previous = window.__achbitFindText;
  if (previous !== input.text) getSelection()?.removeAllRanges();
  window.__achbitFindText = input.text;
  return { found: window.find(input.text, false, input.backwards === true, true, false, true, false) };
}
