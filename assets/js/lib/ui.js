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

const THEME_KEY = 'ab-maps-theme';

/**
 * What the reader chose — 'system', 'light' or 'dark' — which is not the same
 * question as what is on screen.
 *
 * Nothing stored means nothing was chosen, so the OS decides. That has always
 * been the behaviour; it just had no name, which made "follow the system"
 * impossible to offer as a choice because there was no way to go back to it.
 */
export function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'dark' || stored === 'light' ? stored : 'system';
  } catch {
    return 'system';   // private mode — the OS decides and nothing persists
  }
}

/** Whether dark is what is actually showing, chosen or inherited. */
export function isDarkNow() {
  return document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function setTheme(choice) {
  if (choice === 'dark' || choice === 'light') {
    document.documentElement.dataset.theme = choice;
    try { localStorage.setItem(THEME_KEY, choice); } catch { /* nothing to persist to */ }
  } else {
    // Removed rather than stored as "system": the attribute's absence is what
    // hands the decision back to prefers-color-scheme.
    delete document.documentElement.dataset.theme;
    try { localStorage.removeItem(THEME_KEY); } catch { /* nothing to persist to */ }
  }
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: choice } }));
}

/** Put a stored choice back on the page. For pages with no theme control. */
export function applyStoredTheme() {
  const stored = readTheme();
  if (stored !== 'system') document.documentElement.dataset.theme = stored;
  return { isDark: isDarkNow };
}

/** Theme toggle backed by localStorage, defaulting to the OS preference. */
export function initTheme(button) {
  applyStoredTheme();

  const paint = () => {
    if (!button) return;
    const dark = isDarkNow();
    button.innerHTML = dark ? ICON_SUN : ICON_MOON;
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    button.setAttribute('title', dark ? 'Light theme' : 'Dark theme');
  };

  button?.addEventListener('click', () => {
    setTheme(isDarkNow() ? 'light' : 'dark');
    paint();
  });
  paint();
  return { isDark: isDarkNow };
}

const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

/** Transient message stack anchored over the map. */
/**
 * Toasts, with repeats collapsed.
 *
 * A map fires the same error once per failing tile, so a single bad glyph or a
 * dead tile server produced a stack of five identical messages covering the
 * map — the notification became the problem. An identical message still
 * showing is now counted rather than repeated, and its timer restarts so the
 * count stays visible while it is still happening.
 */
export function createToaster(container) {
  const live = new Map();   // message -> { node, count, badge, timer }

  return function toast(message, { tone = 'info', timeout = 6000 } = {}) {
    const existing = live.get(message);
    if (existing) {
      existing.count += 1;
      existing.badge.textContent = `×${existing.count}`;
      existing.badge.hidden = false;
      clearTimeout(existing.timer);
      if (timeout) {
        existing.timer = setTimeout(() => { existing.node.remove(); live.delete(message); }, timeout);
      }
      return existing.node;
    }

    const badge = el('span', { class: 'toast-count', hidden: true });
    const entry = { count: 1, badge, timer: null };

    const dismiss = () => {
      clearTimeout(entry.timer);
      entry.node.remove();
      live.delete(message);
    };

    entry.node = el('div', { class: `toast is-${tone}`, role: tone === 'error' ? 'alert' : 'status' }, [
      el('span', { text: message }),
      badge,
      el('button', {
        class: 'icon-button', 'aria-label': 'Dismiss',
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        onclick: dismiss,
      }),
    ]);

    container.append(entry.node);
    live.set(message, entry);
    if (timeout) entry.timer = setTimeout(dismiss, timeout);
    return entry.node;
  };
}

/** Trigger a client-side file download from a string. */
export function downloadText(filename, text, type = 'application/json') {
  return saveBlob(new Blob([text], { type }), filename);
}

/**
 * Get a file to the person, by whichever route this browser actually has.
 *
 * `<a download>` is the desktop answer and is not available everywhere: an iOS
 * WKWebView - which is what the app is - ignores the attribute, so the click
 * either does nothing or navigates away from the map. That made "Save as a
 * picture" a button that silently failed on the one device most likely to be
 * used to take the picture.
 *
 * The Web Share API is the route that works there, and it is better than a
 * download on a phone anyway: it offers Save to Files alongside Messages and
 * AirDrop. So share first when the browser will take this file, and fall back
 * to the anchor everywhere else.
 *
 * Returns how it went, because the caller has to say something truthful
 * afterwards and "shared", "downloaded" and "cancelled" are three outcomes.
 *
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function saveBlob(blob, filename) {
  const file = typeof File === 'function' ? new File([blob], filename, { type: blob.type }) : null;
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (error) {
      // AbortError is the person tapping Cancel, which is not a failure and
      // must not fall through to a download they did not ask for.
      if (error?.name === 'AbortError') return 'cancelled';
    }
  }

  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
