/**
 * The gear as every page but the map wants it.
 *
 * The map assembles its own, because it has units, a temperature scale, a
 * folder store to sync and a checkout to return to. Every other page wants the
 * same three things — a theme, an account, and the name of the plan — and
 * writing that out in home.js, faq.js and admin.js would be three copies of a
 * sign-in panel to keep in step.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Syncing, because these pages have no folder store and hydrating one would
 * pull IndexedDB, the photo vault and the sync loop onto a page that shows a
 * help article. The account panel is told so and leaves the button out rather
 * than offering to sync nothing.
 *
 * Subscribing, because a checkout is begun and returned to on the map, and the
 * return path — reading the plan again until the webhook lands — lives there.
 * The plan is named here and nothing more, which is what it says on the map
 * too while billing is off.
 */

import { readTheme, setTheme } from './ui.js';
import { icons } from './icons.js';
import { Account } from './account.js';
import { createAccountPanel } from './account-panel.js';
import { wireSettingsMenu } from './settings-menu.js';

/**
 * The theme row, in the same shape and the same words as the map's.
 *
 * Three choices rather than a toggle: the header used to carry a sun-or-moon
 * button that flipped between light and dark and, once pressed, could never
 * hand the decision back to the phone.
 */
export const THEME_ROW = {
  label: 'Theme',
  options: [
    { value: 'system', icon: icons.device, title: 'System' },
    { value: 'light', icon: icons.sun, title: 'Light' },
    { value: 'dark', icon: icons.moon, title: 'Dark' },
  ],
  read: readTheme,
  write: setTheme,
};

/*
 * The folder store the Account wants, reduced to the calls it makes.
 *
 * Same shape admin.js has used since the queue shipped, for the same reason:
 * Account only ever asks for a snapshot and hands back a merge, and a page
 * without folders has neither to give.
 */
const NO_FOLDERS = {
  list: () => [],
  snapshot: () => [],
  replaceAll() {},
  toGeoJSON: () => ({ features: [] }),
};

/**
 * @param {object}   options
 * @param {Function} options.toast     how this page says things out loud
 * @param {object}   [options.account] an existing Account, if the page has one
 * @param {Array}    [options.rows]    extra rows above the theme
 * @returns {{account: object, panel: object, menu: object|null}}
 */
export function mountPageSettings({ toast, account = null, rows = [] } = {}) {
  const who = account || new Account(NO_FOLDERS);

  const panel = createAccountPanel({
    container: document.createElement('div'),
    account: who,
    // No folder store on this page, so no sync line and no Sync now button.
    folders: null,
    toast,
  });
  panel.element.id = 'account-panel';
  panel.element.setAttribute('role', 'group');
  panel.element.setAttribute('aria-label', 'Account');

  const menu = wireSettingsMenu({
    rows: [...rows, THEME_ROW],
    accountPanel: panel,
    account: () => who,
  });

  /*
   * Redraw on every account change, and repaint the menu with it.
   *
   * Signing in from the panel changes what the panel says and what the plan
   * line says, and the two are rebuilt by different functions - so the one
   * that owns the plan has to be told, or somebody signs in and the plan above
   * their name still reads as though nobody is.
   */
  who.addEventListener('change', () => {
    panel.render();
    if (menu) menu.paint();
  });
  panel.render();

  return { account: who, panel, menu };
}
