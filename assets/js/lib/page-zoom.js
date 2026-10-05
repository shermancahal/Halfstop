/**
 * The map page stays at the scale it was laid out for.
 *
 * Reported from an iPhone: the whole page zoomed in, the header and the panel
 * went off the edges, and there was no way back. Zooming the page is easy to
 * do by accident there - tapping a text box set smaller than 16px makes
 * Safari zoom in on it, and every box on this page is (the place search is
 * 14px), and a pinch or a double tap on the header does it too. Undoing it
 * is the part that cannot be done: a page zoom is undone with a pinch, and
 * on this page every pinch lands on the map, which takes it to zoom the map.
 *
 * So the page does not zoom, as no map app's does - the map is what zooms.
 * Three layers, because no one of them holds everywhere:
 *
 * - The viewport says so (MAP_VIEWPORT). That stops Safari zooming in on a
 *   text box, and stops pinch-zooming the page on Android and inside the
 *   apps' web views.
 * - Safari on an iPhone ignores a viewport's limits for a pinch, by design,
 *   since iOS 10. What it does still honour is a page cancelling its own
 *   gesture events, which is what holdPageScale() does. The map is not
 *   affected: MapLibre reads touch events, not these.
 * - CSS (viewer.css) sets touch-action to panning only, which turns off
 *   double-tap zoom on buttons and the panel.
 *
 * Only on the map. The other pages scroll, so a pinch out always lands on
 * the page and zooming them is a reading aid worth keeping.
 */

/** map.html's viewport. test/page-zoom.test.mjs holds the page to it. */
export const MAP_VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

const GESTURES = ['gesturestart', 'gesturechange', 'gestureend'];

/**
 * Cancel Safari's page pinch.
 *
 * @param {EventTarget} [target]  the document
 * @returns {() => void} undoes it
 */
export function holdPageScale(target = globalThis.document) {
  if (!target?.addEventListener) return () => {};
  const cancel = (event) => event.preventDefault();
  for (const name of GESTURES) target.addEventListener(name, cancel, { passive: false });
  return () => {
    for (const name of GESTURES) target.removeEventListener(name, cancel);
  };
}
