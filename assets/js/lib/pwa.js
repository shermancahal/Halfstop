/**
 * Service worker registration, and the update handshake that goes with it.
 *
 * Registration is deliberately conditional on `window.ABMAP_BUILD`, which only
 * tools/build-dist.mjs writes. Running the worker against the dev server would
 * mean cache-first responses for assets that have no `?v=` stamp during
 * development — every edit invisible until a hard reload, which is the exact
 * failure the worker is written to avoid in production.
 *
 * A registered worker is also a foot-gun to uninstall: it outlives the page, so
 * `unregisterServiceWorker()` exists and runs on an unbuilt page, clearing a
 * worker left behind by a previous visit to the deployed site on the same
 * origin. Without it, `npm start` on localhost would be served yesterday's app.
 */

const SUPPORTED = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

/**
 * Register ./sw.js, and call `onUpdate` when a newer worker is installed and
 * waiting behind the one currently running the page.
 *
 * Resolves to the registration, or null when nothing was registered — an
 * unbuilt page, an insecure origin, or a browser without support.
 */
export async function registerServiceWorker({ onUpdate } = {}) {
  if (!SUPPORTED) return null;
  if (!globalThis.ABMAP_BUILD) {
    await unregisterServiceWorker();
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('sw.js', { scope: './' });

    // A worker that is already waiting when the page loads: the update arrived
    // during an earlier visit and was never taken up.
    if (registration.waiting && navigator.serviceWorker.controller) onUpdate?.(registration);

    registration.addEventListener('updatefound', () => {
      const next = registration.installing;
      if (!next) return;
      next.addEventListener('statechange', () => {
        // `controller` is null on the very first install, when there is nothing
        // to update *from* and the prompt would be meaningless.
        if (next.state === 'installed' && navigator.serviceWorker.controller) onUpdate?.(registration);
      });
    });

    return registration;
  } catch (error) {
    console.warn('[pwa] service worker not registered:', error.message);
    return null;
  }
}

/**
 * Take up a waiting worker and reload onto it.
 *
 * The plain reload the build-stamp button used to do is not enough on its own:
 * a waiting worker stays waiting until every tab under its scope is gone, so
 * the page comes back controlled by the old worker and serving the old cache —
 * a reload button that visibly does nothing.
 */
export function applyServiceWorkerUpdate({ timeout = 3000 } = {}) {
  if (!SUPPORTED) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    navigator.serviceWorker.addEventListener('controllerchange', () => done(true), { once: true });
    // Never leave the caller hanging on a worker that does not hand over.
    setTimeout(() => done(false), timeout);

    navigator.serviceWorker.getRegistration().then((registration) => {
      const waiting = registration?.waiting;
      if (!waiting) return done(false);
      waiting.postMessage({ type: 'skip-waiting' });
    }).catch(() => done(false));
  });
}

/** Remove any worker registered for this scope, and the caches it owns. */
export async function unregisterServiceWorker() {
  if (!SUPPORTED) return false;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    let removed = false;
    for (const registration of registrations) removed = (await registration.unregister()) || removed;
    if (removed && typeof caches !== 'undefined') {
      for (const name of await caches.keys()) {
        if (name.startsWith('abmap-')) await caches.delete(name);
      }
      console.warn('[pwa] removed a service worker left over from a built deployment');
    }
    return removed;
  } catch {
    return false;
  }
}

/** True when the page is running as an installed app rather than a browser tab. */
export function isInstalled() {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia('(display-mode: standalone)').matches
    // iOS Safari predates display-mode and reports it here instead.
    || globalThis.navigator?.standalone === true;
}

/**
 * Take up a waiting build and reload onto it, once.
 *
 * For the pages that are prose. The map offers a button instead, because
 * reloading out from under somebody mid-route is worse than a stale build -
 * but the landing page and the help page have nothing in progress to lose, and
 * silently serving yesterday's code there is how a deploy comes to look like
 * it never happened. It did happen: the new worker installed, went to
 * `waiting`, and stayed there, because a waiting worker waits until every tab
 * under its scope is gone and nobody was telling it otherwise.
 *
 * Guarded by sessionStorage so a worker that installs, hands over and somehow
 * still reports an update cannot put the tab in a reload loop. Once per tab is
 * enough: the second load is already on the new build.
 */
export async function reloadOntoNewBuild() {
  const ONCE = 'abmap:took-update';
  try {
    if (sessionStorage.getItem(ONCE)) return false;
  } catch {
    // Private mode, or storage refused. Without somewhere to record that this
    // already happened there is no safe way to reload automatically, so the
    // stale build is the better of the two failures.
    return false;
  }

  const tookOver = await applyServiceWorkerUpdate();
  if (!tookOver) return false;

  /*
   * Marked only now, on the way out.
   *
   * Setting it up front looked safer and was worse: a call that found no
   * waiting worker would still have spent the one chance this tab gets, so a
   * real update arriving later in the same session would have been ignored.
   * The flag exists to stop a loop, and there is no loop to stop until a
   * reload is actually about to happen.
   */
  try { sessionStorage.setItem(ONCE, '1'); } catch { /* nothing to persist to */ }
  globalThis.location.reload();
  return true;
}
