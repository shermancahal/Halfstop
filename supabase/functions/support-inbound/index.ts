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

/**
 * A name out of "Sherman Cahal <sherm@example.com>", or nothing.
 *
 * Resend documents this field as the sender's address and name without
 * committing to a shape, and an object run through String() becomes the
 * literal "[object Object]" in the from column of every ticket. So take the
 * header string, the object, or the one-element array, rather than assume.
 */
function splitFrom(value: unknown): { email: string; name: string } {
  const first = Array.isArray(value) ? value[0] : value;

  if (first && typeof first === 'object') {
    const held = first as Record<string, unknown>;
    const address = String(held.email || held.address || '').trim().toLowerCase();
    if (address) return { name: String(held.name || '').trim(), email: address };
  }

  const raw = String(first || '').trim();
  const angled = /^(.*?)<([^>]+)>$/.exec(raw);
  if (angled) return { name: angled[1].trim().replace(/^"|"$/g, ''), email: angled[2].trim().toLowerCase() };
  return { name: '', email: raw.toLowerCase() };
}

/**
 * The message itself, which the event does not carry.
 *
 * `email.received` is metadata only: sender, recipient, subject, the list of
 * attachments. The body is a second call, and every ticket depends on it, so
 * this is not the optional extra it looks like.
 *
 * The path is tried rather than asserted. Resend's own reference describes
 * the call by its SDK name and its REST routes are versioned, so betting the
 * body of every ticket on one guessed string is the more expensive mistake.
 * A 404 means the wrong shape and moves on; anything else is logged, because
 * the alternative is a queue of empty tickets with no clue why.
 *
 * Best effort on purpose: a ticket with a subject and no body is worth having,
 * and losing the whole message because the second request failed is not.
 */
const BODY_PATHS = [
  (id: string) => `https://api.resend.com/emails/receiving/${id}`,
  (id: string) => `https://api.resend.com/emails/inbound/${id}`,
  (id: string) => `https://api.resend.com/emails/${id}`,
];

async function fetchBody(id: string, key: string): Promise<string> {
  if (!id) return '';
  if (!key) {
    console.warn('RESEND_API_KEY is unset, so tickets arrive with a subject and no body.');
    return '';
  }

  const encoded = encodeURIComponent(id);
  for (const path of BODY_PATHS) {
    const url = path(encoded);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (response.status === 404) continue;
      if (!response.ok) {
        console.warn(`Body fetch answered ${response.status}: ${url}`);
        continue;
      }
      const mail = await response.json();
      const text = String(mail.text || mail.html || '');
      if (text) return text.slice(0, 20000);
    } catch (error) {
      console.warn(`Body fetch failed: ${url}: ${error}`);
    }
  }
  console.warn(`No body found for ${id}. None of the known paths answered.`);
  return '';
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
  const { email, name } = splitFrom(data.from);
  const externalId = String(data.email_id || data.id || '');
  const body = String(data.text || data.html || '')
    || await fetchBody(externalId, Deno.env.get('RESEND_API_KEY') || '');

  const admin = createClient(url, secret, { auth: { persistSession: false } });
  const { error } = await admin.from(TABLE).upsert({
    from_email: email,
    from_name: name,
    subject: String(data.subject || '').slice(0, 500),
    body: body.slice(0, 20000),
    source: 'email',
    // Resend's own id. Null rather than empty when the event somehow has
    // none, so an id-less delivery still files instead of colliding with the
    // last id-less one.
    external_id: externalId || null,
    // Resend retries a delivery it could not confirm. The retry carries the
    // same id, and the queue wants one ticket for one message, so the second
    // arrival is dropped rather than filed again. Dropped, not merged: the
    // ticket may already be answered, and overwriting it would undo that.
  }, { onConflict: 'external_id', ignoreDuplicates: true });
  if (error) return reply(500, { error: `Could not file it: ${error.message}` });

  console.log(`Filed ${externalId || 'a message with no id'}.`);
  return reply(200, { ok: true });
});
