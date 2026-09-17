/**
 * Sign in with Apple and Sign in with Google, drawn the way they are required
 * to be drawn.
 *
 * These two are the only controls on the site that are not ours to design.
 * Both companies publish a branding specification, both make conformance a
 * condition of using the service at all - Google's is checked during app
 * verification, Apple's by App Review - and both specifications are specific
 * about the things a house style would otherwise quietly override: the mark,
 * its colour, its size relative to the button, the wording, and the two or
 * three background colours the button is allowed to have.
 *
 * So they live here rather than as another pair of `.button-secondary`s, with
 * the numbers written down beside the rule they come from. The CSS is in
 * site.css under "branded sign-in", and the two files have to be read
 * together: the proportions are expressed there in terms of one button height.
 *
 *   Apple  https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple
 *   Google https://developers.google.com/identity/branding-guidelines
 *
 * What each specification pins down, in short:
 *
 *   Apple   Title is one of "Sign in with Apple", "Sign up with Apple" or
 *           "Continue with Apple" - not a fourth phrasing. The logo and the
 *           title are both black or both white, never a custom colour, on a
 *           background that stays black or white. Minimum 140x30pt. The title
 *           is 43% of the button's height. The corner radius is ours to pick,
 *           and so is the font, so long as that proportion holds.
 *   Google  The "G" is always the four-colour one, never flattened to a
 *           silhouette and never on a background other than the three it
 *           names. Light #FFFFFF with a #747775 hairline and #1F1F1F text;
 *           dark #131314 with #8E918F and #E3E3E3. 14/20 type, a 20px mark
 *           and 12px of padding in a 40px button, which is where the
 *           fractions in the CSS come from. Scaling is allowed; changing the
 *           proportions is not.
 *
 * The one place they are deliberately read together rather than separately is
 * horizontal alignment. Google's mark sits at the leading edge with the title
 * centred in what is left; Apple's is centred with the title by default, which
 * stacked under Google's would put the two logos in different places and read
 * as a misalignment rather than as two brands. Apple allows exactly this
 * ("you can adjust the space between the logo and the button's leading edge"
 * to align with other authentication logos), so both are laid out Google's
 * way.
 */

import { el } from './ui.js';

/*
 * Apple's mark is not here. It is in the CSS, as a background image.
 *
 * Apple ships the artwork themselves - assets/img/siwa-logo-black.svg and
 * -white.svg, which are their Left-aligned Large files unmodified - and
 * requires that theirs is the artwork used rather than anybody's redrawing of
 * it. Two files, because the mark is black on the light theme and white on the
 * dark one and Apple's are solid colour rather than a shape to tint.
 *
 * Which makes CSS the right place for it: the theme already picks every other
 * colour on this button through a custom property, and one more property
 * holding a url() picks the logo the same way. Inlining it would mean carrying
 * both files in this module and choosing between them in JavaScript, at the
 * one moment - first paint, before any of this has run - when the theme is a
 * thing the stylesheet already knows and this module does not.
 *
 * The files are 39x44 with the padding already in them, and the CSS draws them
 * at the full button height - Apple's stated rule, and what makes that padding
 * come out at the size they drew it for. Large rather than Medium because
 * Apple ships three sizes precisely so the mark can be matched to the other
 * providers' logos, and Medium's smaller apple reads light beside Google's G.
 */

/*
 * The Google "G", in its four fixed colours.
 *
 * The hex values are Google's and are not variables on purpose: a mark that
 * followed the theme would be the monochrome version the guidelines
 * specifically forbid, and a mark that followed the brand palette would be a
 * Google logo in clay. Nothing in this string should ever reference a token.
 */
const GOOGLE_MARK = '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">'
  + '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
  + '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
  + '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
  + '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>'
  + '</svg>';

/* Apple is absent on purpose - see above. An id with no entry draws no inline
   mark, which is exactly what the Apple button wants. */
export const providerMarks = { google: GOOGLE_MARK };

/*
 * "Continue with", not "Sign in with", and the same verb for both.
 *
 * Both sets of guidelines list it - Apple as one of three permitted titles,
 * Google as one of three recommended ones - and it is the only one of the three
 * that is true of this button, which signs an existing account in and creates a
 * new one without asking which was meant.
 *
 * This object is also the list of providers the UI knows how to draw. A
 * provider Supabase reports but that is missing here gets no button, which is
 * the safe direction to fail in: a button with no mark would be a branding
 * violation, where a missing button is only a missing button.
 */
export const PROVIDER_LABELS = {
  apple: 'Continue with Apple',
  google: 'Continue with Google',
};

/**
 * One branded sign-in button.
 *
 * @param {string}   id          'apple' or 'google'
 * @param {object}   [options]
 * @param {Function} [options.onclick]
 * @param {string}   [options.label] one of the titles the provider permits
 * @returns {HTMLButtonElement|null} null for a provider this file cannot title
 */
export function providerButton(id, options = {}) {
  const label = options.label || PROVIDER_LABELS[id];
  if (!label) return null;

  return el('button', {
    class: `provider-button provider-${id}`,
    type: 'button',
    onclick: options.onclick,
  }, [
    /*
     * The hover and press tint, as a layer rather than a background-color.
     *
     * Google's specification gives the state overlay as a percentage over the
     * button fill, and the fill is one of three exact values that a hover must
     * not replace. An absolutely positioned sibling at 8% is that, literally.
     * Apple's black and white have the same constraint by a different route -
     * "the overall colour needs to remain black or white" - so both use it.
     */
    el('span', { class: 'provider-state', 'aria-hidden': 'true' }),
    el('span', { class: 'provider-mark', 'aria-hidden': 'true', html: providerMarks[id] || '' }),
    el('span', { class: 'provider-label', text: label }),
  ]);
}
