/**
 * Invite somebody to view a folder.
 *
 * The grant is the email address, not a token in the link. A bearer link is
 * forwardable - one "look at this" into a group chat and a folder of somebody's
 * saved places is public - so the invitation names an address, the row records
 * it, and the row-level policy matches it against the address on the reader's
 * own session. A forwarded invitation is useless to anybody but the person it
 * names, which is the whole point of doing it this way.
 *
 * The function exists rather than the browser writing the row directly for two
 * reasons: the email has to be sent by something holding an API key, and the
 * folder's existence should be checked against the owner's own rows before an
 * invitation goes out naming it.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * An environment value, with whitespace stripped.
 *
 * The same hazard that cost a round of debugging on the support webhook: a
 * value pasted into a dashboard field with a trailing newline looks identical
 * there and is a different string everywhere else. This function reads the
 * same hand-entered Resend key, and a padded one fails the send while the
 * invitation row is written - so the app would report an invitation recorded
 * and not delivered, for a reason nobody could see.
 */
function env(name: string): string {
  return (Deno.env.get(name) || '').trim();
}

const SITE = env('SITE_URL') || 'https://app.halfstop.app/';

/** What Halfstop is, in the one sentence an invitation has room for. */
const WHAT_IT_IS = 'a field atlas for photographers: scout locations, pin waypoints, and time '
  + 'sunrise, moonset, eclipses and aurora on maps that work with no signal';

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

/** Deliberately loose: the address is checked by whether the invitation arrives. */
const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** The name to put in front of "has invited you", falling back to the address. */
function inviterName(user: Record<string, any>): string {
  const meta = user?.user_metadata || {};
  const named = String(meta.name || meta.full_name || '').trim();
  return named || String(user?.email || 'Somebody');
}

const escapeHTML = (value: string) => value.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
));

/**
 * Send it, or say plainly that nothing was sent.
 *
 * A missing key is not an error: the row is written either way, and the person
 * who was invited can still be told by hand. What must not happen is the app
 * reporting an invitation that no inbox will ever see.
 */
async function sendInvitation(to: string, subject: string, text: string, html: string) {
  const key = env('RESEND_API_KEY');
  const from = env('INVITE_FROM') || 'Halfstop <no-reply@halfstop.app>';
  if (!key) return { sent: false, reason: 'No RESEND_API_KEY is set on this function.' };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!response.ok) {
    return { sent: false, reason: `The mail provider refused it: ${await response.text()}` };
  }
  return { sent: true, reason: '' };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const url = env('SUPABASE_URL');
  const publishable = keyFrom('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const secret = keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !publishable || !secret) {
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: 'Send a JSON body.' });
  }

  const clientId = String(body.clientId || '').trim();
  const email = String(body.email || '').trim().toLowerCase();

  /*
   * The narrower of the two unless the word is exactly 'editor'.
   *
   * Narrowed here rather than trusted from the browser, because this is the
   * difference between showing somebody a folder and letting them change it,
   * and the request asking for it is written by whatever is on the other end.
   * The browser narrows it too; that one is a typo guard, this one is the
   * rule.
   */
  const role = String(body.role || '').trim().toLowerCase() === 'editor' ? 'editor' : 'viewer';
  if (!clientId) return reply(400, { error: 'Which folder?' });
  if (!looksLikeEmail(email)) return reply(400, { error: 'That does not look like an email address.' });
  if (email === String(user.email || '').toLowerCase()) {
    return reply(400, { error: 'That is your own address, so you already have this folder.' });
  }

  const admin = createClient(url, secret, { auth: { persistSession: false } });

  /*
   * The folder has to exist, and be theirs.
   *
   * Checked against the owner's rows with the service key rather than through
   * the caller's session, because the caller can now also *read* folders
   * shared with them - and an invitation to somebody else's folder, sent by
   * somebody who was only shown it, is exactly the hole that would open.
   */
  const { data: folder, error: folderError } = await admin
    .from('folders')
    .select('client_id, name, deleted')
    .eq('user_id', user.id)
    .eq('client_id', clientId)
    .maybeSingle();
  if (folderError) return reply(500, { error: `Could not check the folder: ${folderError.message}` });
  if (!folder || folder.deleted) {
    return reply(404, { error: 'That folder is not on your account yet. Sync it and try again.' });
  }

  const folderName = String(folder.name || body.folderName || 'a folder');
  const from = inviterName(user);

  const { error: shareError } = await admin
    .from('folder_shares')
    .upsert({
      owner_id: user.id,
      client_id: clientId,
      invited_email: email,
      folder_name: folderName,
      invited_by: from,
      role,
      // Re-inviting somebody who was withdrawn restores them, at whatever the
      // new invitation says rather than at whatever the old one did.
      revoked: false,
    }, { onConflict: 'owner_id,client_id,invited_email' });
  if (shareError) return reply(500, { error: `Could not record the invitation: ${shareError.message}` });

  const subject = `${from} shared “${folderName}” with you on Halfstop`;
  const asked = role === 'editor' ? `work on ${folderName} with them` : `view ${folderName}`;
  const line = `${from} has invited you to ${asked} on Halfstop, `
    + `${WHAT_IT_IS}. It will require you to create a free account on Halfstop.`;
  const text = `${line}\n\nOpen it here: ${SITE}\n\n`
    + `Sign in with this address (${email}) and the folder will be waiting.`;
  const html = `<p>${escapeHTML(line)}</p>`
    + `<p><a href="${escapeHTML(SITE)}">Open Halfstop</a></p>`
    + `<p>Sign in with this address (${escapeHTML(email)}) and the folder will be waiting.</p>`;

  const { sent, reason } = await sendInvitation(email, subject, text, html);
  return reply(200, { ok: true, emailed: sent, reason, folder: folderName });
});
