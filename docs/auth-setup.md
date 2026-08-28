# Sign-in: what has to be set outside this repository

The code sends the right return address. Supabase decides whether to honour it,
and that decision is a dashboard setting this repository cannot see or change.
This is the list.

## 1. The redirect allow list — this is the bug you have been hitting

**Authentication → URL Configuration**

- **Site URL:** `https://shermancahal.github.io/Map/`
- **Redirect URLs:** add `https://shermancahal.github.io/Map/**`

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
3. **Site URL** — a single field. Set it to `https://shermancahal.github.io/Map/`.
   This is the fallback every unmatched redirect lands on, which is why the
   wrong value here was so hard to spot: it was being used as a *default*, not
   rejected as an *error*.
4. **Redirect URLs** — a list, with an **Add URL** button. Add:

   ```
   https://shermancahal.github.io/Map/**
   ```

5. Save.

Two notes on the pattern. `*` matches within one path segment and `**` matches
across segments, so the double star is what covers `/Map/map.html` and
`/Map/faq.html` both. And a redirect carrying a query string still matches —
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
   `com.americanbyways.gps.web`.
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
redirect back to `https://shermancahal.github.io/Map/` leaves the app rather
than returning to it. Making sign-in work there needs a deep link — a custom
scheme or a universal link registered with iOS, added to the allow list above,
and handled on the way back in.

Nothing in the web build is blocked by this. It is listed so that "sign-in
works" is not mistaken for "sign-in works in the app".

## 4. Email delivery, when there is a real domain

The default sender is Supabase's, which is rate limited and sends from their
domain. **Authentication → Emails → SMTP Settings** takes over both, and is
worth doing once there is a domain to send from. It changes nothing about the
redirect problem above, which is separate and comes first.
