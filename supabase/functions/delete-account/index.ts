/**
 * Delete the signed-in account, for real.
 *
 * The app can delete somebody's rows from the browser, because row-level
 * security lets a signed-in person delete their own. It cannot delete the auth
 * record: that needs the service key, and a service key in a page is a service
 * key in everybody's devtools. So the browser did what it could and the app
 * said the rest happened "on request" - while privacy.html told readers the
 * account itself was deleted. This closes that gap rather than rewording it.
 *
 * WHOSE ACCOUNT GETS DELETED
 *
 * The one whose token this request carries, and nothing else. The user id is
 * read from the verified JWT, never from the body: a function that deleted
 * whichever id it was handed would be an unauthenticated delete of anybody's
 * account, wearing an authenticated function's clothes. There is deliberately
 * no way to name a different user.
 *
 * ORDER
 *
 * Photos, then rows, then the auth record. Deleting the user first would leave
 * the rows and pictures behind with no session able to reach them - the
 * policies check a signed-in user who no longer exists - and the only thing
 * that could clean them up afterwards is another service-key call.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

/** The table the app keeps folders in. Rows are filed under `user_id`. */
const TABLE = 'folders';

/** Where the photos on pins are kept: one object each, at `<account id>/<photo id>`. */
const PHOTOS = 'pin-photos';

/** How many objects one list or remove call takes - the Storage API's page. */
const PAGE = 1000;

/**
 * Remove every photo this account uploaded.
 *
 * Listed and removed a page at a time until the account's place is empty,
 * rather than trusting one list to be the whole of it. A photo left behind
 * after the account is gone is a picture of somewhere that nobody can ever
 * take down, which is the one outcome this function exists to prevent.
 */
async function removePhotos(admin: ReturnType<typeof createClient>, userId: string): Promise<string> {
  for (let round = 0; round < 1000; round += 1) {
    const { data, error } = await admin.storage.from(PHOTOS).list(userId, { limit: PAGE });
    if (error) return error.message;
    const paths = (data || []).map((entry: { name: string }) => `${userId}/${entry.name}`);
    if (!paths.length) return '';
    const { error: removeError } = await admin.storage.from(PHOTOS).remove(paths);
    if (removeError) return removeError.message;
  }
  return 'too many photos to remove in one go';
}

/*
 * Both key generations, because a project can be on either.
 *
 * The legacy service_role key is a plain string in SUPABASE_SERVICE_ROLE_KEY;
 * the newer secret keys arrive as a JSON object in SUPABASE_SECRET_KEYS, keyed
 * by name. Reading whichever exists means this function keeps working across
 * that migration instead of failing on the day the legacy key is turned off.
 */
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

/*
 * Any origin, because there is nothing here to steal with one.
 *
 * The request is authorised by a bearer token the browser has to attach on
 * purpose, not by a cookie a third-party page could ride on, so the usual
 * reason to pin an origin does not apply - and the app runs from three of them
 * anyway: the site, a Capacitor shell at capacitor://localhost, and localhost
 * during development.
 */
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const url = Deno.env.get('SUPABASE_URL') || '';
  const publishable = keyFrom('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const secret = keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !publishable || !secret) {
    return reply(500, { error: 'This function is missing its Supabase environment.' });
  }

  const authorization = req.headers.get('Authorization') || '';
  if (!authorization) return reply(401, { error: 'Sign in first.' });

  // Who is asking, according to the token rather than according to them.
  const asCaller = createClient(url, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data, error: whoError } = await asCaller.auth.getUser();
  const user = data?.user;
  if (whoError || !user) return reply(401, { error: 'That session is not valid.' });

  const admin = createClient(url, secret, { auth: { persistSession: false } });

  const photoError = await removePhotos(admin, user.id);
  if (photoError) return reply(500, { error: `Could not delete your photos: ${photoError}` });

  const { error: rowsError } = await admin.from(TABLE).delete().eq('user_id', user.id);
  if (rowsError) return reply(500, { error: `Could not delete your folders: ${rowsError.message}` });

  const { error: userError } = await admin.auth.admin.deleteUser(user.id);
  if (userError) return reply(500, { error: `Could not delete the account: ${userError.message}` });

  return reply(200, { ok: true, deleted: user.id });
});
