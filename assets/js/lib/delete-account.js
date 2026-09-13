/**
 * Closing the account, kept somewhere you have to mean to go.
 *
 * This was a button on the account card, one row under Sign out. Apple
 * requires an app offering sign-in to offer deletion, so it has to exist and
 * be reachable - but "reachable" was being read as "present", and present in a
 * menu people open to change a theme is a mis-tap that cannot be undone.
 *
 * So it lives in the help page now, inside the answer about closing an
 * account, where somebody arrives having gone looking. That is still in the
 * app and still reachable without asking anybody, which is what the
 * requirement is about; what it is no longer is adjacent to Sign out.
 *
 * One module rather than a second copy of the two confirmations: the warning
 * text is the only thing standing between a stray tap and every folder on the
 * server, and two copies of it is one that drifts.
 */

import { el } from './ui.js';
import { withIcon } from './ui.js';
import { icons } from './icons.js';
import { isConfigured as accountsAvailable } from './account.js';

const WARNING = 'Delete your account?\n\n'
  + 'The account itself is closed, and your folders and pins are removed from '
  + 'the server. Signing in again will not bring any of it back. What is saved '
  + 'on this device is left alone.\n\n'
  + 'This cannot be undone.';

/**
 * @param {object}   options
 * @param {Element}  options.container where to draw
 * @param {object}   options.account   an Account
 * @param {Function} options.toast     how this page says things out loud
 * @returns {{render: Function}}
 */
export function mountDeleteAccount({ container, account, toast }) {
  function render() {
    if (!container) return;
    container.replaceChildren();

    if (!accountsAvailable()) {
      container.append(el('p', {
        class: 'hint',
        text: 'Accounts are not set up for this deployment, so there is nothing to close.',
      }));
      return;
    }

    /*
     * Signed out, this says who it would close rather than offering a button
     * that cannot work. The address is the confirmation that matters - the
     * wrong account closed is the same outcome as the right one.
     */
    if (!account.user) {
      container.append(el('p', {
        class: 'hint',
        text: 'Sign in first, from the settings menu at the top of the page. '
          + 'The button appears here once the app knows whose account to close.',
      }));
      return;
    }

    const button = el('button', {
      class: 'button button-ghost button-small is-danger', type: 'button',
      text: `Delete ${account.user.email || 'this account'}`,
      title: 'Remove your folders from the server and close the account',
      onclick: async () => {
        // Two confirmations rather than one: the first says what goes, the
        // second asks for the word, because nothing here can be undone.
        if (!window.confirm(WARNING)) return;
        if (window.prompt('Type DELETE to confirm.') !== 'DELETE') {
          toast('Nothing was deleted.', { tone: 'info' });
          return;
        }
        button.disabled = true;
        const result = await account.deleteAccount()
          .catch((error) => ({ ok: false, reason: error.message }));
        button.disabled = false;
        toast(result.ok ? 'Account deleted.' : `Could not delete: ${result.reason}`,
          { tone: result.ok ? 'ok' : 'error' });
      },
    });
    withIcon(button, icons.trash);

    container.append(el('div', { class: 'account-actions account-danger' }, [button]));
  }

  account.addEventListener('change', render);
  render();
  return { render };
}
