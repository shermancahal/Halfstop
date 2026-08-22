/** Small DOM helpers shared by the landing page and the viewer. */

export function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Theme toggle backed by localStorage, defaulting to the OS preference. */
export function initTheme(button) {
  const KEY = 'ab-maps-theme';
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* private mode — fall back to OS */ }
  if (stored === 'dark' || stored === 'light') document.documentElement.dataset.theme = stored;

  const isDark = () => (document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches);

  const paint = () => {
    if (!button) return;
    const dark = isDark();
    button.innerHTML = dark ? ICON_SUN : ICON_MOON;
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    button.setAttribute('title', dark ? 'Light theme' : 'Dark theme');
  };

  button?.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* nothing to persist to */ }
    paint();
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  });
  paint();
  return { isDark };
}

const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

/** Transient message stack anchored over the map. */
export function createToaster(container) {
  return function toast(message, { tone = 'info', timeout = 6000 } = {}) {
    const node = el('div', { class: `toast is-${tone}`, role: tone === 'error' ? 'alert' : 'status' }, [
      el('span', { text: message }),
      el('button', {
        class: 'icon-button', 'aria-label': 'Dismiss',
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        onclick: () => node.remove(),
      }),
    ]);
    container.append(node);
    if (timeout) setTimeout(() => node.remove(), timeout);
    return node;
  };
}

/** Trigger a client-side file download from a string. */
export function downloadText(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
