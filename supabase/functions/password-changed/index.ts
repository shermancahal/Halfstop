/**
 * Tell somebody their password just changed.
 *
 * Supabase sends the reset link and then nothing: the change itself is silent,
 * so the one person who most needs to know it happened - the account holder
 * who did not do it - finds out when they can no longer sign in. That is the
 * whole point of this notice, and it is why it exists as a function rather
 * than as a line in the app: the app only tells whoever is already holding the
 * session, which is exactly the wrong person in the case that matters.
 *
 * WHERE THE ADDRESS COMES FROM
 *
 * The verified token, and nowhere else. There is no address in the body and
 * there must never be one: a function holding a mail key that sends wherever
 * the request says is an open relay wearing this project's domain. The body is
 * not read at all.
 *
 * It is also why this cannot leak whether an address has an account. Reaching
 * it needs a session, and a session is proof of the account already.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * An environment value, with whitespace stripped.
 *
 * The same hazard that cost a round of debugging on the support webhook: a
 * value pasted into a dashboard field with a trailing newline looks identical
 * there and is a different string everywhere else.
 */
function env(name: string): string {
  return (Deno.env.get(name) || '').trim();
}

const SITE = env('SITE_URL') || 'https://app.halfstop.app/';
const SUPPORT = env('SUPPORT_EMAIL') || 'support@halfstop.app';

function keyFrom(jsonName: string, legacyName: string): string {
  const bundle = env(jsonName);
  if (bundle) {
    try {
      const keys = JSON.parse(bundle);
      const value = keys.default || Object.values(keys)[0];
      if (typeof value === 'string' && value) return value;
    } catch {
      // Fall through to the legacy name rather than failing on a shape change.
    }
  }
  return env(legacyName);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const escapeHTML = (value: string) => value.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
));

/**
 * When it happened, in words rather than a timestamp.
 *
 * UTC and named as such. A reader deciding whether this was them needs to
 * compare it against their own afternoon, and "14:52" with no zone is a number
 * they cannot use for that.
 */
function whenText(now: Date): string {
  return `${now.toUTCString().replace(/ GMT$/, '')} UTC`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const url = env('SUPABASE_URL');
  const publishable = keyFrom('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  if (!url || !publishable) {
    return reply(500, { error: 'This function is missing its Supabase environment.' });
  }

  const authorization = req.headers.get('Authorization') || '';
  if (!authorization) return reply(401, { error: 'Sign in first.' });

  const asCaller = createClient(url, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: who, error: whoError } = await asCaller.auth.getUser();
  const user = who?.user;
  if (whoError || !user) return reply(401, { error: 'That session is not valid.' });

  const to = String(user.email || '').trim();
  // An account with no address - a provider sign-in that never supplied one -
  // has nowhere to be told. Not an error: the password still changed.
  if (!to) return reply(200, { sent: false, reason: 'That account has no email address.' });

  const key = env('RESEND_API_KEY');
  const from = env('INVITE_FROM') || 'Halfstop <no-reply@halfstop.app>';
  if (!key) return reply(200, { sent: false, reason: 'No RESEND_API_KEY is set on this function.' });

  const when = whenText(new Date());
  const subject = 'Your Halfstop password was changed';
  const text = [
    'The password on your Halfstop account was just changed.',
    '',
    `Account: ${to}`,
    `When:    ${when}`,
    '',
    'If that was you, there is nothing to do and you can ignore this.',
    '',
    'If it was not you, somebody else has your account. Use "Forgot your',
    `password?" at ${SITE} to take it back, and write to ${SUPPORT} so we know.`,
    '',
    'This notice is sent whenever the password changes. Nobody at Halfstop can',
    'read your password, so we cannot tell you what it was set to.',
  ].join('\n');

  const html = `<p>The password on your Halfstop account was just changed.</p>
<p><b>Account:</b> ${escapeHTML(to)}<br><b>When:</b> ${escapeHTML(when)}</p>
<p>If that was you, there is nothing to do and you can ignore this.</p>
<p>If it was not you, somebody else has your account. Use
<b>Forgot your password?</b> at <a href="${escapeHTML(SITE)}">${escapeHTML(SITE)}</a>
to take it back, and write to
<a href="mailto:${escapeHTML(SUPPORT)}">${escapeHTML(SUPPORT)}</a> so we know.</p>
<p>This notice is sent whenever the password changes. Nobody at Halfstop can read
your password, so we cannot tell you what it was set to.</p>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!response.ok) {
    /*
     * 200 with sent:false, not an error status.
     *
     * The password has already changed by the time anything calls this. A 5xx
     * here would have the app report a failure for something that succeeded,
     * which is worse than a missing notice - it invites somebody to change it
     * again, in a form that now wants a password they have already replaced.
     */
    return reply(200, { sent: false, reason: `The mail provider refused it: ${await response.text()}` });
  }
  return reply(200, { sent: true, reason: '' });
});
