/**
 * The two properties of an Edge Function that cannot be checked by running it.
 *
 * These are Deno and they call live services, so the suite cannot execute
 * them. What it can do is read them, and the things worth reading for are the
 * ones where a later edit made in good faith opens a hole quietly:
 *
 *   - whether the gateway is checking the caller's token
 *   - whether a function holding a mail key trusts the request body
 *
 * Neither shows up as a failure anywhere. A function that starts sending
 * wherever the body says still works perfectly for the person using the app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../supabase/', import.meta.url);

const config = await readFile(new URL('config.toml', root), 'utf8');
const names = (await readdir(new URL('functions/', root), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

test('functions: every one of them says out loud whether it checks a token', async () => {
  /*
   * Silence is not the safe default here, it is just the default. Supabase
   * verifies the JWT unless told otherwise, so a function that needs to be
   * reachable without one fails with a 401 from the gateway and nothing in its
   * own log - which cost a round of debugging on the support webhook already.
   * Either way the answer belongs in the file rather than in somebody's head.
   */
  const undeclared = names.filter((name) => !config.includes(`[functions.${name}]`));
  assert.deepEqual(undeclared, [], 'these functions have no verify_jwt line in config.toml');
});

test('functions: the ones that send email never take the address from the body', async () => {
  /*
   * The whole safety of password-changed is that the address comes off the
   * verified token. A body naming one is a body somebody else can write, and a
   * function holding a Resend key that sends wherever the request says is an
   * open relay wearing this project's domain - which is the kind of thing a
   * domain gets blocklisted for, silently, weeks later.
   *
   * invite-to-folder is the deliberate exception and is listed as one: an
   * invitation is addressed to somebody else by definition. It pays for that
   * by checking the folder belongs to the caller before anything is sent.
   */
  const ADDRESSES_SOMEBODY_ELSE = new Set(['invite-to-folder']);

  const offenders = [];
  for (const name of names) {
    if (ADDRESSES_SOMEBODY_ELSE.has(name)) continue;
    const source = await readFile(new URL(`functions/${name}/index.ts`, root), 'utf8');
    if (!source.includes('api.resend.com')) continue;

    // `to:` built from anything the caller wrote, rather than from the token.
    const takesFromBody = /\bto\s*:\s*\[?\s*(?:String\()?\s*body\./.test(source)
      || /const\s+to\s*=[^;]*\bbody\./.test(source);
    if (takesFromBody) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'these send mail to an address the request chose');
});

test('functions: password-changed reads the recipient off the verified token', async () => {
  const source = await readFile(new URL('functions/password-changed/index.ts', root), 'utf8');
  assert.match(source, /const to = String\(user\.email/,
    'the recipient is no longer the signed-in user');
  assert.match(config, /\[functions\.password-changed\][\s\S]*?verify_jwt = true/,
    'without the gateway check, anybody could ask this to send');
  assert.ok(!/await req\.json\(\)/.test(source),
    'it reads a request body it has no reason to read');
});
