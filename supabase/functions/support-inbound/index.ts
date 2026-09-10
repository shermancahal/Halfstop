/**
 * Mail to support@halfstop.app, turned into a row in the queue.
 *
 * Resend receives it and POSTs an `email.received` event here. The event
 * carries metadata rather than the message, so the body is fetched back from
 * the API by id; a queue of subject lines with no message in them would be a
 * list of things to go and read somewhere else.
 *
 * WHY THIS ONE IS NOT BEHIND A JWT
 *
 * Every other function in this project requires a session, because a person is
 * on the other end. Resend has no session and never will, so this is deployed
 * with verify_jwt off and authorises the caller itself: a shared secret that
 * has to match, compared in a way that does not leak how much of it matched.
 * Without the secret set, the function refuses everything rather than
 * accepting anonymous posts into a table only one person can read.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const TABLE = 'support_tickets';

function keyFrom(jsonName: string, legacyName: string): string {
  const bundle = Deno.env.get(jsonName);
  if (bundle) {
    try {
      const keys = JSON.parse(bundle);
      const value = keys.default || Object.values(keys)[0];
      if (typeof value === 'string' && value) return value;
    } catch {
      // Fall through to the legacy name rather than failing on a shape change.
    }
  }
  return Deno.env.get(legacyName) || '';
}

/** Constant time, so a wrong secret cannot be guessed a character at a time. */
function secretMatches(given: string, expected: string): boolean {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A name out of "Sherman Cahal <sherm@example.com>", or nothing. */
function splitFrom(value: string): { email: string; name: string } {
  const raw = String(value || '').trim();
  const angled = /^(.*?)<([^>]+)>$/.exec(raw);
  if (angled) return { name: angled[1].trim().replace(/^"|"$/g, ''), email: angled[2].trim().toLowerCase() };
  return { name: '', email: raw.toLowerCase() };
}

/**
 * The message itself, which the event does not carry.
 *
 * Best effort on purpose: a ticket with a subject and no body is worth having,
 * and losing the whole message because the second request failed is not.
 */
async function fetchBody(id: string, key: string): Promise<string> {
  if (!id || !key) return '';
  try {
    const response = await fetch(`https://api.resend.com/emails/inbound/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return '';
    const mail = await response.json();
    return String(mail.text || mail.html || '').slice(0, 20000);
  } catch {
    return '';
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const expected = Deno.env.get('SUPPORT_WEBHOOK_SECRET') || '';
  if (!expected) return reply(503, { error: 'This endpoint has no secret configured, so it accepts nothing.' });

  const given = req.headers.get('x-halfstop-secret')
    || new URL(req.url).searchParams.get('secret')
    || '';
  if (!secretMatches(given, expected)) return reply(401, { error: 'No.' });

  const url = Deno.env.get('SUPABASE_URL') || '';
  const secret = keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !secret) return reply(500, { error: 'This function is missing its Supabase environment.' });

  let event: Record<string, any>;
  try {
    event = await req.json();
  } catch {
    return reply(400, { error: 'Send a JSON body.' });
  }

  const data = event?.data || event || {};
  const { email, name } = splitFrom(data.from || '');
  const body = String(data.text || data.html || '')
    || await fetchBody(String(data.email_id || data.id || ''), Deno.env.get('RESEND_API_KEY') || '');

  const admin = createClient(url, secret, { auth: { persistSession: false } });
  const { error } = await admin.from(TABLE).insert({
    from_email: email,
    from_name: name,
    subject: String(data.subject || '').slice(0, 500),
    body: body.slice(0, 20000),
    source: 'email',
    // Resend's own id, so a redelivered webhook is recognisable rather than a
    // second ticket about the same message.
    external_id: String(data.email_id || data.id || ''),
  });
  if (error) return reply(500, { error: `Could not file it: ${error.message}` });

  return reply(200, { ok: true });
});
