/**
 * Signing in, the profile, and the way out — on whichever page asks for it.
 *
 * This was `renderAccount()` inside viewer.js, where it could reach the map's
 * `state` and `toast` directly. It is here because the settings menu it lives
 * in is now on every page, and the alternative was a second copy of the
 * sign-in form: two places to fix a confirmation email, two places to forget
 * the delete-account button Apple requires.
 *
 * Rendered entirely from account state so there is one source of truth for
 * what is on screen. When Supabase is not configured the section explains that
 * folders are device-only rather than showing a sign-in form that cannot work.
 */

import { el } from './ui.js';
import { withIcon } from './ui.js';
import { icons } from './icons.js';
import { isConfigured as accountsAvailable, displayName } from './account.js';
import { describeSync } from './sync.js';
import { SITE } from '../config.js';

/**
 * @param {object}   options
 * @param {Element}  options.container where to draw, usually #account-panel
 * @param {object}   options.account   an Account
 * @param {object}   [options.folders] the real folder store, or null
 * @param {Function} options.toast     how this page says things out loud
 *
 * `folders` decides whether syncing is offered at all. A page that has no
 * folder store has nothing to sync, and "0 folders synced" there is not a
 * neutral statement - it reads as "your folders are gone" to somebody who has
 * twenty seven of them on the map page.
 */
export function createAccountPanel({ container, account, folders = null, toast }) {
  /*
   * The half-finished edit and the half-typed address live here rather than in
   * a page's state object, because they are this panel's business and nothing
   * else ever read them. They also have to survive a redraw, which is why they
   * are not local to render().
   */
  let edit = null;
  let emailDraft = '';
  let changing = false;

  function profileForm() {
    const draft = edit;
    const name = el('input', {
      type: 'text', placeholder: 'Your name', autocomplete: 'name', 'aria-label': 'Name',
      value: draft.name, maxlength: 80,
      oninput: (event) => { draft.name = event.target.value; },
    });
    const email = el('input', {
      type: 'email', placeholder: 'you@example.com', autocomplete: 'email', 'aria-label': 'Email',
      value: draft.email,
      oninput: (event) => { draft.email = event.target.value; },
    });
    const busy = (on) => { for (const node of [name, email, save, cancel]) node.disabled = on; };
    const save = el('button', {
      class: 'button button-primary button-small', type: 'submit', text: 'Save',
    });
    const cancel = el('button', {
      class: 'button button-ghost button-small', type: 'button', text: 'Cancel',
      onclick: () => { edit = null; render(); },
    });
    return el('form', {
      class: 'account-form',
      onsubmit: async (event) => {
        event.preventDefault();
        busy(true);
        try {
          await account.updateProfile({ name: draft.name, email: draft.email });
          edit = null;
        } catch (error) {
          toast(error.message, { tone: 'error', timeout: 10000 });
        } finally {
          busy(false);
        }
        render();
      },
    }, [name, email, el('div', { class: 'account-actions' }, [save, cancel])]);
  }

  /*
   * Choosing a password: after a reset link, or deliberately while signed in.
   *
   * Typed twice, because this is the one field in the app whose value is
   * hidden as it is typed and cannot be checked afterwards - the cost of a
   * typo here is being locked out by the very thing that was meant to let you
   * back in.
   */
  function passwordForm({ onDone }) {
    const first = el('input', {
      type: 'password', placeholder: 'New password', autocomplete: 'new-password',
      'aria-label': 'New password',
    });
    const again = el('input', {
      type: 'password', placeholder: 'New password again', autocomplete: 'new-password',
      'aria-label': 'Confirm new password',
    });
    const save = el('button', {
      class: 'button button-primary button-small', type: 'submit', text: 'Save password',
    });
    const cancel = el('button', {
      class: 'button button-ghost button-small', type: 'button', text: 'Cancel',
      onclick: () => { changing = false; render(); },
    });
    const busy = (on) => { for (const node of [first, again, save, cancel]) node.disabled = on; };

    return el('form', {
      class: 'account-form',
      onsubmit: async (event) => {
        event.preventDefault();
        if (first.value !== again.value) {
          toast('Those two passwords are not the same.', { tone: 'error' });
          return;
        }
        busy(true);
        try {
          await account.setPassword(first.value);
          changing = false;
          toast('Password changed.', { tone: 'ok' });
          onDone?.();
        } catch (error) {
          toast(error.message, { tone: 'error', timeout: 10000 });
        } finally {
          busy(false);
        }
        render();
      },
    }, [first, again, el('div', { class: 'account-actions' }, [save, cancel])]);
  }

  function render() {
    if (!container) return;
    container.replaceChildren();

    if (!accountsAvailable()) {
      container.append(el('p', {
        class: 'hint',
        text: 'Accounts are not set up for this deployment, so folders stay in this browser.',
      }));
      return;
    }

    if (account.user) {
      emailDraft = '';
      const { user } = account;
      const name = displayName(user);

      /*
       * One thing per line: who, then what can be changed, then the sync, then
       * the two buttons. It was a single row with the address cut off at
       * "sherm…" beside two buttons, which is the layout of a header - and this
       * is no longer in one.
       */
      const who = el('div', { class: 'account-who' }, [
        el('div', { class: 'account-name', text: name || user.email || 'Signed in' }),
        name && user.email ? el('div', { class: 'account-email', text: user.email }) : null,
      ]);

      /*
       * Somebody who followed a reset link is here for one thing.
       *
       * Shown before the profile, the sync line and the buttons, because they
       * arrived holding a link and every other control is a distraction from
       * the reason they clicked it. No Cancel out of this one either - the
       * account is reachable again either way, but leaving without setting a
       * password means the next visit starts at the same dead end.
       */
      if (account.recovering) {
        container.append(
          who,
          el('p', { class: 'hint', style: 'margin-bottom:9px', text: 'Choose a new password for this account.' }),
          passwordForm({ onDone: () => toast('You are signed in.', { tone: 'ok' }) }),
        );
        return;
      }

      if (changing) {
        container.append(who, passwordForm({}));
        return;
      }

      if (edit) {
        container.append(who, profileForm());
        if (account.message) container.append(el('p', { class: 'hint', text: account.message }));
        return;
      }

      const editButton = el('button', {
        class: 'button button-ghost button-small account-edit', type: 'button', text: 'Edit profile',
        onclick: () => {
          edit = { name, email: user.email || '' };
          render();
        },
      });
      withIcon(editButton, icons.pencil);

      /*
       * Changing it on purpose, which the reset flow also needs to exist.
       *
       * Somebody who signed in with an emailed link has no password at all, or
       * has one they have forgotten and just worked around. Without this the
       * only route to a known password is to sign out and ask for a reset -
       * which means deliberately locking yourself out to fix being locked out.
       */
      const passwordButton = el('button', {
        class: 'button button-ghost button-small account-password', type: 'button', text: 'Change password',
        onclick: () => { changing = true; render(); },
      });
      withIcon(passwordButton, icons.key);

      const signOut = el('button', {
        class: 'button button-ghost button-small', type: 'button', text: 'Sign out',
        // signOut swallows a failed server call and clears the device either
        // way, so the only thing left to catch is the unexpected.
        onclick: () => account.signOut().catch((error) => toast(error.message, { tone: 'error' })),
      });
      withIcon(signOut, icons.logout);

      /*
       * Deleting the account, from inside the app.
       *
       * Apple requires this of anything offering sign-in, and the privacy
       * policy promises it. Two confirmations rather than one: the first says
       * what goes, the second asks for the word, because this is the only
       * button here that destroys something and cannot be undone.
       */
      const deleteAccount = el('button', {
        class: 'button button-ghost button-small is-danger', type: 'button', text: 'Delete account',
        title: 'Remove your folders from the server and close the account',
        onclick: async () => {
          const warning = 'Delete your account?\n\n'
            + 'The account itself is closed, and your folders and pins are removed from '
            + 'the server. Signing in again will not bring any of it back. What is saved '
            + 'on this device is left alone.\n\n'
            + 'This cannot be undone.';
          if (!window.confirm(warning)) return;
          if (window.prompt('Type DELETE to confirm.') !== 'DELETE') {
            toast('Nothing was deleted.', { tone: 'info' });
            return;
          }
          const result = await account.deleteAccount()
            .catch((error) => ({ ok: false, reason: error.message }));
          toast(result.ok ? 'Account deleted.' : `Could not delete: ${result.reason}`,
            { tone: result.ok ? 'ok' : 'error' });
        },
      });
      withIcon(deleteAccount, icons.trash);

      container.append(who, editButton, passwordButton);

      /*
       * Syncing, only where there is something to sync.
       *
       * The map page has the folder store; the others deliberately do not,
       * because hydrating it would pull IndexedDB, the photo vault and the
       * sync loop onto a page that shows a help article.
       */
      if (folders) {
        const totals = folders.totals();
        const syncLine = account.status === 'syncing'
          ? 'Syncing…'
          : `${totals.folders} folder${totals.folders === 1 ? '' : 's'} synced`
            + (account.lastSyncAt
              ? ` · ${new Date(account.lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
              : '');
        const syncNow = el('button', {
          class: 'button button-secondary button-small', type: 'button',
          text: account.status === 'syncing' ? 'Syncing…' : 'Sync now',
          disabled: account.status === 'syncing',
          onclick: async () => {
            const result = await account.sync();
            if (result) toast(describeSync(result), { tone: 'ok' });
          },
        });
        withIcon(syncNow, icons.refresh);
        container.append(
          el('div', { class: 'account-meta', text: syncLine }),
          el('div', { class: 'account-actions' }, [syncNow, signOut]),
        );
      } else {
        container.append(el('div', { class: 'account-actions' }, [signOut]));
      }

      container.append(el('div', { class: 'account-actions account-danger' }, [deleteAccount]));

      if (account.message) container.append(el('p', { class: 'hint', text: account.message }));
      return;
    }

    /* signed out */
    const email = el('input', {
      type: 'email', placeholder: 'you@example.com', autocomplete: 'email', 'aria-label': 'Email',
      value: emailDraft,
      oninput: (event) => { emailDraft = event.target.value; },
    });
    const password = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
    // `forgot` is declared below; busy only ever runs from a click, long after.
    // It belongs in here - without it a double tap sends two reset emails.
    const busy = (on) => { for (const node of [email, password, ...buttons, forgot]) node.disabled = on; };

    /*
     * Say the thing that just happened where somebody will see it.
     *
     * The sentence itself stays in account.js, beside the branch that chose it -
     * signing up as an address that already exists and signing up as a new one
     * are different messages, and repeating either here would be two copies to
     * keep in step. This only decides that it is said out loud.
     */
    const announce = (tone) => {
      if (account.message) toast(account.message, { tone, timeout: 15000 });
    };

    const run = async (action) => {
      emailDraft = email.value.trim();
      if (!emailDraft) { toast('Enter your email address first.', { tone: 'error' }); return; }
      busy(true);
      try {
        await action();
      } catch (error) {
        toast(error.message, { tone: 'error', timeout: 10000 });
      } finally {
        // No re-render here: the account emits 'change' when the status actually
        // moves, and rebuilding on every attempt would wipe the form mid-typing.
        busy(false);
      }
    };

    const buttons = [
      el('button', {
        class: 'button button-primary button-small', type: 'button', text: 'Sign in',
        onclick: () => run(() => account.signIn(emailDraft, password.value)),
      }),
      el('button', {
        class: 'button button-secondary button-small', type: 'button', text: 'Create account',
        onclick: () => run(async () => {
          const result = await account.signUp(emailDraft, password.value);
          // Nothing visible happens on a successful signup: no session, so the
          // panel redraws identically and the only sign of life was a muted line
          // appended below three buttons, off the bottom of a phone screen.
          // Reported as "creating an account does not state anything", which is
          // what it looked like - and the person then had no reason to go
          // looking in their spam folder, where the email was.
          if (!result.confirmed) announce(result.existing ? 'info' : 'ok');
        }),
      }),
      el('button', {
        class: 'button button-ghost button-small', type: 'button', text: 'Email me a link',
        title: 'Sign in without a password',
        onclick: () => run(async () => {
          await account.signInWithLink(emailDraft);
          announce('ok');
        }),
      }),
    ];

    /*
     * The way back in, said in the words somebody would actually search for.
     *
     * "Email me a link" already signs you in without a password and is sitting
     * right there, but it is labelled as a shortcut, so the person who has
     * forgotten theirs has no reason to read it as the answer - and taking it
     * leaves them signed in with a password they still do not know.
     *
     * Its own line under the buttons rather than a fourth button beside them:
     * this is the thing you look for when the three above have failed, and it
     * should not compete with them until then.
     */
    const forgot = el('button', {
      class: 'button button-ghost button-small account-forgot', type: 'button',
      text: 'Forgot your password?',
      onclick: () => run(async () => {
        await account.resetPassword(emailDraft);
        announce('ok');
      }),
    });

    /*
     * Apple and Google first, and above the form rather than under it.
     *
     * Not decoration: the emailed link is the part that has broken repeatedly,
     * and a provider round trip has no link to lose. Putting them first offers
     * the route most likely to work before the one that needs an inbox.
     *
     * `run` is not used here - it insists on an email address, and the whole
     * point of these is that you do not type one.
     */
    const provider = (id, label) => el('button', {
      class: 'button button-secondary button-small', type: 'button', text: label,
      onclick: async () => {
        try {
          await account.signInWithProvider(id);
        } catch (error) {
          toast(error.message, { tone: 'error', timeout: 10000 });
        }
      },
    });

    /*
     * Only the providers the project has actually set up.
     *
     * Asked of the project rather than kept in config, because the two drift and
     * the drift fails both ways: a provider registered and not listed is a
     * button nobody sees, and one listed and not registered sends the reader to
     * an error page carrying Apple's or Google's branding, which reads as this
     * site being broken rather than unfinished.
     */
    const PROVIDER_LABELS = { apple: 'Continue with Apple', google: 'Continue with Google' };
    const offered = (account?.providers || SITE.authProviders || [])
      .filter((id) => PROVIDER_LABELS[id]);

    container.append(
      el('p', {
        class: 'hint', style: 'margin-bottom:10px',
        text: 'Sign in to keep your folders and pins on every device you use. '
          + 'Photographs stay on the device they were added to.',
      }),
    );
    if (offered.length) {
      container.append(
        el('div', { class: 'account-actions' }, offered.map((id) => provider(id, PROVIDER_LABELS[id]))),
        el('p', { class: 'hint account-or', text: 'or with an email address' }),
      );
    }
    container.append(
      email,
      password,
      el('div', { class: 'account-actions' }, buttons),
      forgot,
    );
    if (account.message) container.append(el('p', { class: 'hint', style: 'margin-top:9px', text: account.message }));
  }

  return { element: container, render };
}
