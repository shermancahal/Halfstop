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

## 2. Apple and Google

**Authentication → Providers**

Each needs enabling and a client ID and secret from the provider's own console.
Supabase gives the callback URL to register there; it is the project's
`.../auth/v1/callback`, not this site.

Two things worth knowing before you start:

- **Apple requires a paid developer account** and a Services ID separate from
  the app ID. Google does not.
- **If the iOS app offers Google sign-in, the App Store requires Apple sign-in
  too.** That is a review rule rather than a technical one, and it is a common
  reason for a first submission to be rejected.

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
