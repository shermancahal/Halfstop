/**
 * Colour scales: the layers whose colours are a quantity, and how to draw one
 * as a bar.
 *
 * Weather, light pollution and sky brightness are read by colour and nothing
 * else — a shade of blue on the temperature map means nothing until it has a
 * number beside it. Their keys used to live behind the (i) on each row, so
 * reading the map meant opening the panel, finding the layer and holding a
 * colour in your head on the way back. A scale along the bottom of the map is
 * where every printed atlas puts it, and it is there for as long as the layer
 * is.
 *
 * Which layers count is decided here, from the catalogue, so the panel and the
 * strip on the map cannot disagree about it. Pure functions only: fetching a
 * service's key and drawing it are the viewer's job.
 */

/**
 * The scale a layer carries, or null for one whose colours are categories.
 *
 * Public lands has a key too, but BLM is not "more" than the Forest Service;
 * a bar would claim an order the colours do not have. So a fixed list of
 * colours is a scale only when the catalogue says so with `scale: true`.
 *
 * @returns {{kind: 'service', url: string, unit: string}
 *   | {kind: 'arcgis', url: string, layer: number, unit: string}
 *   | {kind: 'steps', steps: {color: string, label: string, short?: string}[], unit: string}
 *   | {kind: 'ramp', colors: string[], from: string, to: string, unit: string}
 *   | null}
 */
export function scaleFor(entry) {
  if (!entry) return null;
  const unit = entry.scaleUnit || '';
  if (entry.legendScale) return { kind: 'service', url: entry.legendScale, unit };
  if (entry.legendRamp?.colors?.length >= 2) {
    return {
      kind: 'ramp',
      colors: [...entry.legendRamp.colors],
      from: entry.legendRamp.from || '',
      to: entry.legendRamp.to || '',
      unit,
    };
  }
  if (!entry.scale) return null;
  if (entry.legendJSON?.url) {
    return { kind: 'arcgis', url: entry.legendJSON.url, layer: entry.legendJSON.layer, unit };
  }
  if (Array.isArray(entry.legend) && entry.legend.length >= 2) {
    return { kind: 'steps', steps: entry.legend.map((step) => ({ ...step })), unit };
  }
  return null;
}

/**
 * Which steps of a long scale get a label under the bar.
 *
 * A temperature ramp is twenty-odd steps and a phone is about three hundred
 * pixels across, so labelling every one would print a row of overlapping
 * numbers. Both ends always — they are the range, which is the first thing
 * anybody wants — and evenly spaced steps between them, up to `most` in all.
 *
 * @returns {number[]} Ascending, unique indices into the step list.
 */
export function scaleTicks(count, most = 5) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return [];
  if (n === 1) return [0];
  const slots = Math.max(2, Math.min(n, Math.floor(Number(most) || 2)));
  const picked = new Set();
  for (let i = 0; i < slots; i += 1) picked.add(Math.round((i * (n - 1)) / (slots - 1)));
  return [...picked].sort((a, b) => a - b);
}

/**
 * A continuous ramp as a CSS gradient, left to right.
 *
 * Light pollution has no list of steps to draw — it is a photograph of the
 * night, dark to bright — so its bar is a gradient through the colours the
 * picture actually uses.
 */
export function rampGradient(colors) {
  const list = (colors || []).filter(Boolean);
  if (!list.length) return 'transparent';
  if (list.length === 1) return list[0];
  return `linear-gradient(to right, ${list.join(', ')})`;
}

/**
 * The words under a fixed list of steps.
 *
 * A step may carry a `short` form for the bar — "3" where the panel says
 * "Bortle 3 · rural" — because a bar cell is a fifth of a phone wide and the
 * long form would wrap to three lines in it.
 */
export function stepLabel(step) {
  return String(step?.short ?? step?.label ?? '').trim();
}

/**
 * Whether a list of steps needs its long labels written out as well.
 *
 * Only when the bar shows something shorter than the full label: "3" says
 * where on the scale you are, and "rural" is what that means.
 */
export function needsGlossary(steps) {
  return (steps || []).some((step) => step?.short != null
    && String(step.short).trim() !== String(step.label ?? '').trim());
}
