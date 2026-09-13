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
        // One word, and nothing under it. The countdown used to live here on
        // the grounds that a trial ending unannounced is a surprise - but this
        // is a menu somebody opened to change their units, and the place that
        // sentence actually does some work is the upgrade panel, where it is
        // still said, beside the thing that stops the clock.
        el('div', { class: 'plan-name', text: plan.name }),
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
