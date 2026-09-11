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
 * Mail that arrived as HTML only, made readable.
 *
 * The queue renders a ticket body as text, which is the right call for
 * anything that came out of somebody else's mail client, and it means an
 * HTML-only message lands as a wall of markup nobody can triage. Apple Mail
 * sends no plain text part at all, so this is the ordinary case rather than
 * the awkward one.
 *
 * Not a parser and not trying to be. It keeps the line breaks the markup
 * implies, keeps a link's address beside its text because a support message
 * is so often a link to the thing that is broken, and discards the rest.
 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018',
  ldquo: '\u201c', rdquo: '\u201d',
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<a\b[^>]*href=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, label) => {
        const text = label.replace(/<[^>]+>/g, '').trim();
        return !text || text === href ? href : `${text} (${href})`;
      },
    )
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(stripped)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The plain text part if the sender sent one, otherwise the HTML made plain. */
function pickBody(source: Record<string, unknown> | null | undefined): string {
  const text = String(source?.text || '').trim();
  return text || htmlToText(String(source?.html || ''));
}

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
      const text = pickBody(mail);
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

  // Trimmed because this value is typed into a dashboard field, and a paste
  // that brought a newline along with it looks identical to the right secret
  // while being a different string to compare against. That cost one full
  // round of "the secret is set and it still says no": the stored value was
  // the right forty-eight characters with two more of whitespace around them.
  //
  // Only this side is trimmed. What arrives in the request is compared exactly
  // as it arrived, so this forgives a paste into the dashboard without also
  // widening what an unknown caller is allowed to send.
  const expected = (Deno.env.get('SUPPORT_WEBHOOK_SECRET') || '').trim();
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
  const body = pickBody(data)
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
