/**
 * The gear in the header, on every page that has a header.
 *
 * It began on the map, because that is where units and a theme belonged. Then
 * the account moved into it, and signing in stopped being reachable from the
 * landing page, the help page or the terms — which is where somebody arrives
 * first and where "how do I get my folders on my phone" is actually asked.
 *
 * So the panel is built here and the page says what belongs in it. The map
 * passes its units and temperature rows and the purchase block; the others
 * pass neither, and get a gear holding a theme, an account and a plan. Nothing
 * is hidden by CSS — a row that is not passed is not built.
 */

import { el } from './ui.js';
import { planSummary } from './tiers.js';

/**
 * @param {object}    options
 * @param {Array}     [options.rows]        {label, options, read, write} per row
 * @param {object|Function} [options.accountPanel] from createAccountPanel, or a
 *   function returning one. Both are resolved at paint rather than at wiring,
 *   because the map builds its header before it has finished hydrating an
 *   account, and a value read too early is a panel that never appears.
 * @param {object|Function} [options.account]      an Account, for the plan summary
 * @param {Function}  [options.planExtra]    (plan) => Node|null, the map's buttons
 * @param {string}    [options.triggerId]
 * @param {string}    [options.panelId]
 * @param {string}    [options.menuId]
 * @returns {{paint: Function, setOpen: Function}|null} null when the page has no gear
 */
export function wireSettingsMenu({
  rows = [],
  accountPanel = null,
  account = null,
  planExtra = null,
  triggerId = 'settings-trigger',
  panelId = 'settings-panel',
  menuId = 'settings-menu',
} = {}) {
  const trigger = document.getElementById(triggerId);
  const drop = document.getElementById(panelId);
  const menu = document.getElementById(menuId);
  if (!trigger || !drop) return null;

  // Resolved when the panel is drawn, not when it is wired: see the note on
  // the parameters above.
  const resolve = (value) => (typeof value === 'function' ? value() : value);

  const setOpen = (open) => {
    drop.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) paint();
  };

  function paint() {
    /*
     * Keep the caret where it was.
     *
     * replaceChildren below takes the account panel out of the document and
     * puts it back, and a node that leaves the document loses focus with it.
     * So anything arriving while somebody is typing - a plan landing, a sync
     * finishing - used to move the cursor out of the field mid-word, which on
     * a password field is invisible and ends as "those two do not match".
     */
    const active = document.activeElement;
    const caret = drop.contains(active) && typeof active.selectionStart === 'number'
      ? { node: active, start: active.selectionStart, end: active.selectionEnd }
      : null;

    drop.replaceChildren(...rows.map((setting) => el('div', { class: 'settings-row' }, [
      el('div', { class: 'settings-label', text: setting.label }),
      el('div', {
        class: 'settings-choices',
        style: `--choices:${setting.options.length}`,
      }, setting.options.map((option) => el('button', {
        class: `settings-choice${setting.read() === option.value ? ' is-on' : ''}`,
        type: 'button',
        title: option.title, 'aria-label': option.title,
        'aria-pressed': String(setting.read() === option.value),
        ...(option.icon ? { html: option.icon } : { text: option.label }),
        onclick: () => {
          if (setting.read() === option.value) return;
          setting.write(option.value);
          paint();
        },
      }))),
    ])));

    /*
     * The account, under the same button.
     *
     * Signing in is a preference about this device, not a place to go, and it
     * had a whole header control of its own showing a truncated email beside
     * five icons. It has to be re-appended on every paint because
     * replaceChildren above has just taken it out.
     */
    const panel = resolve(accountPanel);
    if (panel?.element) {
      panel.element.hidden = false;
      drop.append(el('div', { class: 'settings-account' }, [
        el('div', { class: 'settings-label', text: 'Account' }),
        panel.element,
      ]));
    }

    /*
     * The plan, named and nothing more, where the account is.
     *
     * One word: "free" is only reassuring if somebody says it, and a reader
     * who has been asked to sign in has reasonably wondered what it is going
     * to cost.
     *
     * `planExtra` is how the map adds the purchase and manage buttons without
     * this module knowing anything about Stripe. A page that passes nothing
     * shows the name and stops, which is the honest state off the map: a
     * checkout is started and returned to on one page, and offering to begin
     * one from the terms page would be a route nobody has tested.
     */
    const who = resolve(account);
    if (who) {
      const plan = planSummary(who);
      drop.append(el('div', { class: 'settings-account' }, [
        el('div', { class: 'settings-label', text: 'Plan' }),
        /*
         * The name, and the date under it when there is one.
         *
         * This held one word and nothing else, on the grounds that a trial
         * countdown does not belong in a menu somebody opened to change their
         * units. That still holds for a countdown. A date does not read the
         * same way: somebody who has just cancelled comes here to check that
         * it took, and "Premium" on its own answers a different question than
         * the one they are asking. It says whether the date is a renewal or an
         * ending, so it cannot be misread as either.
         *
         * Silent for an account with nothing to report - Free, or the account
         * that runs the service, whose Premium has no end date at all.
         */
        el('div', { class: 'plan-name', text: plan.name }),
        plan.renewal ? el('p', { class: 'hint plan-renewal', text: plan.renewal }) : null,
        planExtra ? planExtra(plan) : null,
      ].filter(Boolean)));
    }

    /*
     * Where the terms and the privacy policy are, from inside the app.
     *
     * They have always existed and were only ever reachable from the website.
     * That is fine for a browser tab, where the reader can get to the site,
     * and not fine once this is wrapped as an app: the map is then the only
     * page there is, and App Review expects both to be findable in a build
     * that asks people to make an account.
     */
    drop.append(el('div', { class: 'settings-account settings-legal' }, [
      el('a', { href: 'privacy.html', target: '_blank', rel: 'noopener', text: 'Privacy' }),
      el('a', { href: 'terms.html', target: '_blank', rel: 'noopener', text: 'Terms' }),
      el('a', { href: 'faq.html', target: '_blank', rel: 'noopener', text: 'Help' }),
    ]));

    // Only if that exact field is still on the page: a redraw that replaced it
    // has nothing to give focus back to, and guessing would be worse.
    if (caret && drop.contains(caret.node)) {
      caret.node.focus({ preventScroll: true });
      try { caret.node.setSelectionRange(caret.start, caret.end); } catch { /* not a text field */ }
    }
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(drop.hidden);
  });
  document.addEventListener('click', (event) => {
    if (drop.hidden) return;
    if (!menu?.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    // Focus goes back to the gear, or Escape leaves it nowhere and the next
    // Tab starts from the top of the document.
    if (event.key === 'Escape' && !drop.hidden) { setOpen(false); trigger.focus(); }
  });
  // Without this, choosing a unit or typing an address closes the panel,
  // because the click reaches the document handler above.
  drop.addEventListener('click', (event) => event.stopPropagation());

  return { paint, setOpen };
}
