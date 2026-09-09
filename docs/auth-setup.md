# Sign-in: what has to be set outside this repository

The code sends the right return address. Supabase decides whether to honour it,
and that decision is a dashboard setting this repository cannot see or change.
This is the list.

## 1. The redirect allow list — this is the bug you have been hitting

**Authentication → URL Configuration**

- **Site URL:** `https://app.halfstop.app/`
- **Redirect URLs:** add `https://app.halfstop.app/**`

Why it matters more than it looks. Every auth call in `account.js` now passes
an explicit `emailRedirectTo` or `redirectTo`. Supabase compares that against
the allow list and, when it does not match, **silently falls back to the Site
URL** rather than refusing. That is why a confirmation email arrived pointing
at a host this project has never used: the Site URL was set to it, nothing in
the request was wrong, and nothing reported an error.

Until the deployment URL is in that list, the code change has no effect.

### Adding it, step by step

1. Go to <https://supabase.com/dashboard> and pick the project.
2. **Authentication** in the left sidebar → **URL Configuration**.
3. **Site URL** — a single field. Set it to `https://app.halfstop.app/`.
   This is the fallback every unmatched redirect lands on, which is why the
   wrong value here was so hard to spot: it was being used as a *default*, not
   rejected as an *error*.
4. **Redirect URLs** — a list, with an **Add URL** button. Add:

   ```
   https://app.halfstop.app/**
   ```

5. Save.

Two notes on the pattern. `*` matches within one path segment and `**` matches
across segments, so the double star is what covers `/map.html` and
`/faq.html` both. And a redirect carrying a query string still matches —
the comparison is against the path, not the whole URL.

Nothing needs redeploying. The next sign-in attempt uses the new list.

## 2. Apple and Google

**Authentication → Providers**

Each needs enabling and a client ID and secret from the provider's own console.
Supabase gives the callback URL to register there; it is the project's
`.../auth/v1/callback`, not this site.

### Google — do this one first

Free, and no domain to verify.

1. <https://console.cloud.google.com> → create a project.
2. **APIs & Services → OAuth consent screen.** External. Fill in the app name
   and support email. While it is in Testing, only accounts you list can sign
   in; publishing lifts that.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**.
4. Under **Authorised redirect URIs** paste the callback Supabase shows on its
   Google provider page. It looks like
   `https://<project-ref>.supabase.co/auth/v1/callback` — Supabase's domain,
   not this site's.
5. Copy the client ID and client secret into Supabase → **Authentication →
   Providers → Google**, and enable it.

### Apple — the paid one, and the order that avoids wasted money

**Enrolment.** <https://developer.apple.com/programs/enroll/>. Currently 99 USD
a year. An Apple ID with two-factor authentication is required. Choose
**Individual** unless the apps must be published under a company name —
Organization enrolment needs a D-U-N-S number and takes considerably longer.

**Then, in Certificates, Identifiers & Profiles:**

1. **Identifiers → + → App IDs** — create one for the app itself, and tick
   **Sign in with Apple** in its capabilities.
2. **Identifiers → + → Services IDs** — this is the separate one, and it is
   what the *web* sign-in uses. Give it an identifier such as
   `com.halfstop.app.web`.
3. Open that Services ID → tick **Sign in with Apple** → **Configure**:
   - **Primary App ID:** the one from step 1.
   - **Domains and Subdomains** and **Return URLs:** the Supabase callback,
     `https://<project-ref>.supabase.co/auth/v1/callback`.
4. **Keys → + →** tick **Sign in with Apple**, configure it against the primary
   App ID, and download the `.p8`. **It downloads once and cannot be retrieved
   again** — losing it means generating a new key. Note the **Key ID** on that
   page and the **Team ID** from the top right of the portal.
5. In Supabase → **Authentication → Providers → Apple**: the Services ID is the
   client ID, and the secret is built from the `.p8`, Key ID and Team ID.

**The thing most likely to stop you, flagged before you pay.** Apple wants the
domain in *Domains and Subdomains* to be one you can prove you own, by hosting
a verification file on it. The callback above is on `supabase.co`, which is not
yours. Whether Apple accepts a third-party callback domain without that step —
and it has historically been inconsistent — is worth checking before enrolling,
because the usual way around it is a **custom domain on the Supabase project**,
which is a paid add-on on top of the 99 USD.

So the sensible order is: **Google now, Apple when there is a real domain.**
Google costs nothing and needs no verification, and it is enough to prove the
whole provider flow works end to end. Apple only becomes necessary when the
iOS app ships — at which point the App Store rule below applies anyway.

**The App Store rule.** If the app offers any third-party sign-in, it must also
offer Sign in with Apple. That is a review requirement rather than a technical
one, and a common reason for a first submission to be rejected.

## 3. The app is a separate problem

Inside the Capacitor shell the web view's origin is not this site, so a
redirect back to `https://app.halfstop.app/` leaves the app rather
than returning to it. Making sign-in work there needs a deep link — a custom
scheme or a universal link registered with iOS, added to the allow list above,
and handled on the way back in.

Nothing in the web build is blocked by this. It is listed so that "sign-in
works" is not mistaken for "sign-in works in the app".

## 4. Email that never arrives

Three different things produce "I asked for an account and nothing came back",
and they are worth telling apart before changing any settings, because two of
them are free to fix and one costs a domain.

### First: read the auth log. It settles which of the three it is.

**Logs → Auth Logs** in the sidebar (older dashboards put it under
**Authentication → Logs**). Filter to the minute you pressed the button.

- **No signup event at all** — the request never reached Supabase. A key or
  URL problem in `token.js`, not an email problem.
- **A signup event, and no mail event** — the address already has an account.
  Supabase names it outright: `POST /signup` returning **200** with
  `user repeated signup: request completed`. See below; no email was ever going
  to be sent.
- **A signup event and a failed mail event** — delivery. Rate limit or SMTP.

That order matters: the fix for each is in a different place, and the symptom
on screen is identical.

### The address already has an account

Supabase will not tell a stranger whether an address is registered. Signing up
one that already exists returns success, with a user, no session, an empty
`identities` array — **and sends nothing**. There is no error anywhere, and the
auth log shows the signup succeeding.

The app now reads that array and says so rather than telling you to check an
inbox nothing is coming to. If you see that message the account exists, so:

- **Sign in** with the password, which needs no email at all. Try this first.
- **Email me a link** if the password is gone — but note that this one *does*
  need delivery to work, so a magic link that never arrives puts you back in
  the rate-limit case below with a different symptom.

### The built-in sender's rate limit

The default sender is Supabase's own, and it is throttled hard — a handful of
emails per hour per project, and the exact number has been lowered more than
once. **Authentication → Rate Limits** shows the current figure for "Rate limit
for sending emails".

Over that limit, requests are **rejected rather than queued**: the send fails,
the signup still looks fine on screen, and nothing arrives. Testing sign-in a
few times in a row is enough to hit it, which makes it look intermittent — the
first attempt of the day works and the next three do not.

That service is documented as being for development only. A real sender is the
fix, and it also removes the throttle:

**Authentication → Emails → SMTP Settings → Enable Custom SMTP.** Host, port
587, username and password from the provider, and a sender address on a domain
you control — which is the part that needs a domain. Resend, Postmark, Mailgun
and SES all have free or near-free tiers at this volume.

None of this touches the redirect problem in section 1, which is separate and
comes first: fixing delivery only means the wrong link arrives reliably.

---

## Deleting an account, all the way

`Settings → Account → Delete account` deletes the person's folder rows from the
browser, which row-level security allows, and then closes the auth record
through an Edge Function — because that part needs the service key, and a
service key in a page is a service key in everybody's devtools.

The function is `supabase/functions/delete-account/index.ts`. It is deployed
with `verify_jwt` on, and it reads **whose** account to close from the caller's
own verified token; there is deliberately no way to name a different user in
the request. Rows first, then the record: deleting the user first would strand
the rows behind a policy that checks a user who no longer exists.

Deploy it with the CLI, or from the dashboard:

```sh
supabase functions deploy delete-account
```

It needs no secrets of its own. `SUPABASE_URL` and the service key are in every
function's environment already; the code reads either generation of that key,
so it survives the move from `service_role` to the newer secret keys.

If the function is unreachable the app still deletes the rows and says the
account itself was not closed, pointing at support@halfstop.app — one of the
two outcomes needs a human, and they should not read the same.

---

## Sharing a folder with somebody

Stage one of collaboration: the owner invites an address, and that person can
**read** the folder. Nobody but the owner can write to it, which is what keeps
the sync model honest — last-write-wins per folder is safe while a folder has
exactly one writer, and is not safe the moment it has two.

**The grant is the email address, not a token in a link.** A bearer link is
forwardable; one "look at this" into a group chat and a folder of somebody's
saved places is public. The invitation names an address, the row records it,
and the row-level policy matches it against the address on the reader's own
session. A forwarded invitation is useless to anybody but the person it names.

What is in `schema.sql`:

- `folder_shares` — one row per (owner, folder, invited address), `revoked`
  rather than deleted so a withdrawn invitation is distinguishable from one
  that never existed.
- A **select** policy on `folders` that consults it. A second policy rather
  than a change to the first: policies are OR'd, so this adds a way to read and
  leaves insert, update and delete owner-only.

The reader's copy is marked `sharedFrom` in the browser, and that marker is
what keeps it out of the push — `mergeFolders` holds it back, and the folder
row offers no editing controls. Both are belt and braces: the policy would
refuse the write anyway.

### The email

`supabase/functions/invite-to-folder` writes the row and sends the invitation.
Deploy it with the CLI or the dashboard:

```sh
supabase functions deploy invite-to-folder
```

It needs two secrets, and **sends nothing until they are set**:

| Secret | What it is |
| --- | --- |
| `RESEND_API_KEY` | An API key from the mail provider |
| `INVITE_FROM` | The sender, e.g. `Halfstop <no-reply@halfstop.app>` |

Without them the invitation is still recorded, and the app says so rather than
claiming somebody was emailed. That distinction is deliberate: an invitation
nobody receives and an invitation that failed are different problems, and only
one of them needs the sender to go and tell their friend by hand.

`SITE_URL` is optional and defaults to `https://app.halfstop.app/`.

---

## Wiring Resend, both halves

Two separate things use it, and they authenticate differently: Supabase Auth
sends the confirmation and magic-link mail over **SMTP**, and
`invite-to-folder` sends invitations over the **HTTP API**. One API key serves
both.

### 1. Verify a sending subdomain

Resend → Domains → Add Domain, and use `send.halfstop.app` rather than the bare
domain. A domain may publish only one SPF record, and the root already has one
for the mailboxes; a subdomain gets its own and the two cannot collide. Add the
DKIM and SPF records Resend gives you to the DNS for halfstop.app and wait for
**Verified**.

### 2. One API key

Resend → API Keys → Create, with sending access only. It is shown once.

### 3. Supabase Auth → SMTP

**Authentication → Emails → SMTP Settings → Enable Custom SMTP:**

| Field | Value |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` — literally that word, for every account |
| Password | the API key |
| Sender email | `no-reply@send.halfstop.app` |
| Sender name | `Halfstop` |

Then **Authentication → Rate Limits**, and raise "Rate limit for sending
emails". Supabase imposes 30/hour when custom SMTP is first enabled.

This is also the step that makes signups work for strangers at all. Until
custom SMTP is configured, **Supabase Auth refuses to deliver to any address
that is not a member of the project's team** — so an invitation to somebody
else was never going to arrive, whatever this repository did.

### 4. The function's secrets

**Edge Functions → Secrets:**

| Secret | Value |
| --- | --- |
| `RESEND_API_KEY` | the same key |
| `INVITE_FROM` | `Halfstop <no-reply@send.halfstop.app>` |

`INVITE_FROM` is not optional once a subdomain is verified: the function
defaults to `no-reply@halfstop.app`, and Resend refuses a sender on a domain it
has not verified. Secrets take effect immediately — no redeploy.

### 5. Prove it

Sign up with an address that has nothing to do with the project team, then
share a folder with a second one. Resend's own log says whether each message
was accepted, and the app says `emailed: true` only when the provider took it.

---

## The auth emails themselves

Six templates in `supabase/email-templates/`, to paste into **Authentication →
Emails → Templates**. Each file is the body; the subject goes in the field
above it:

| Dashboard template | File | Subject |
| --- | --- | --- |
| Confirm signup | `confirm-signup.html` | Confirm your email |
| Magic Link | `magic-link.html` | Your sign-in link |
| Reset Password | `reset-password.html` | Reset your password |
| Change Email Address | `change-email.html` | Confirm your new address |
| Invite user | `invite.html` | You have been invited to Halfstop |
| Reauthentication | `reauthentication.html` | Your confirmation code |

Three things about them are deliberate, and all three come from Supabase's own
guidance on keeping authentication mail out of spam folders.

**No images.** Not even the mark. An authentication email that depends on a
remote image looks like every phishing attempt that also does, and the header
is a navy bar with a word in it for exactly that reason.

**No names or addresses in the body.** Nothing personal is interpolated, so
there is nothing for an attacker to place there and nothing for a filter to
weigh. The one exception is the code in Reauthentication, which is the message.

**Short subjects, no emoji**, and the recovery line every one of them ends on:
what to do if you did not ask for this. Usually "ignore it and nothing
happens", which is the honest answer and the reassuring one.

Reauthentication carries `{{ .Token }}` rather than a link on purpose: it
confirms somebody is still there before something irreversible, so it must not
be openable from an inbox alone.

The "Invite user" template is Supabase's own admin invitation, which is a
different thing from sharing a folder — that invitation is sent by
`invite-to-folder` through Resend directly and does not pass through these
templates at all.
