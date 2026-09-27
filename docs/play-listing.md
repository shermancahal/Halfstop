# Google Play: the store listing and the App content forms

What to type into Play Console, worked out from what the app actually does,
so the answers agree with `privacy.html`, the code and each other. Play checks
the Data safety form against the privacy policy and against the app at
review, and a mismatch is a rejection - or, later, a policy notice.

Nothing here needs to be right the first time for **internal testing**: Play
lets an internal release out before the listing and most of these forms are
finished. All of it is needed before a closed or production release.

The in-app purchase setup is separate, in the Google Play section of
[payments.md](payments.md).

---

## Store listing (Grow users → Store presence → Main store listing)

**App name** (30 characters at most):

```
Halfstop: Field Atlas
```

**Short description** (80 at most - this one is 78):

```
A field atlas for photographers: scout locations, pin them and time the light.
```

**Full description** (4000 at most). Every feature is listed as free or
Premium the way `assets/js/lib/tiers.js` gates it, because a store listing
that promises a Premium feature as free is the misleading-claims kind of
rejection:

```
Halfstop is a field atlas for photographers. Scout a location, drop a pin, and know exactly when the sun, the moon or the aurora will be where you need it.

TIME THE LIGHT
• Sunrise, sunset, golden hour, blue hour, moonrise and moonset for any pin
• Eclipse paths across the map

KNOW THE GROUND
• USGS topographic quads, aerial imagery, hillshade and contours
• National forest, BLM, state land, wilderness and park boundaries
• Forest road numbers and drone ceilings

PIN IT
• Save waypoints into folders by trip, by season, or by the light they need
• Search for a place by name, from OpenStreetMap
• Open GPX, KML, KMZ and GeoJSON files - including your Google Maps starred places and saved lists, from Google Takeout
• Export any folder as GPX or GeoJSON whenever you like, free, with or without an account
• Sync up to 100 folders and 100 waypoints between your phone and your computer, free

PREMIUM
For the parts that cost us money every time they are used:
• Syncing any number of folders between your phone and your computer
• Inviting others to view a folder or work on it with you
• Search that also finds businesses and street addresses, from Mapbox
• Offline map downloads, for when the bars run out
• Weather layers: cloud cover, fog, snow and storm tracks
• Trip planning with road routing
• Photographs kept with a waypoint
• State-level detail maps and extra basemaps

$4.99 a month or $49 a year in the US, through Google Play. There is a free month to try it first, with nothing to cancel - it simply ends. Cancel a subscription any time in the Play Store.

No ads, no analytics, no tracking.

Maps are for planning. Carry a paper map where it matters, and use your own judgement in front of the actual ground.
```

**Graphics**

| Asset | File |
| --- | --- |
| App icon, 512 × 512 | `assets/img/icon-512.png` |
| Feature graphic, 1024 × 500 | `docs/store/play-feature-graphic.png` - regenerate with `node tools/build-feature-graphic.mjs`, on the Mac for the site's own serif |
| Phone screenshots, 2 to 8 | from the emulator or a phone, below |

Screenshots: in the emulator, the camera button in the toolbar on the right
saves one to the desktop. Portrait, and the four that say the most:

1. The map with a folder of pins over a topo or aerial basemap
2. A pin's panel open, showing the sun and moon times
3. Public land boundaries (a national forest or BLM area)
4. The folder list, or a trip

**Category**: *Maps & Navigation*. **Tags**: photography, maps, outdoors.

**Contact details** (Store settings): email `support@halfstop.app`, website
`https://app.halfstop.app/`.

---

## App content (Policy and programs → App content)

### Privacy policy

```
https://app.halfstop.app/privacy.html
```

### App access

Choose *All or some functionality is restricted*. Most of the app works with
no account, but Premium is behind sign-in and a subscription, and Play's
reviewers need to reach it without paying. Make them an account:

1. Sign up on the website with an address you control, such as a
   `+review` alias of your own.
2. In **Admin** (the footer link, on your account), grant that account Premium
   with no end date.
3. In the form: name *Premium review account*, the email and password, and:
   > Premium features (weather layers, offline downloads, trip routing, sync)
   > are unlocked on this account. Everything else works without signing in.

### Ads

*No, my app does not contain ads.*

### Content rating

Start the questionnaire, category *All other app types*. The answers that
matter:

| Question | Answer | Why |
| --- | --- | --- |
| Violence, sexuality, language, drugs, gambling | No | None of it |
| Users interact or exchange content | **Yes** | Folder invitations let two accounts share and edit places |
| Shares the user's current location with other users | No | Pins are shared; the live position never leaves the device |
| Digital purchases | **Yes** | Premium |

It should come out as *Everyone*, with the interaction and purchase notes.

### Target audience

*18 and over*. The privacy policy already says Halfstop is not directed at
children, and choosing any age under 18 brings extra requirements - under 13
puts the app into the Families policy - for an audience it is not built for.

### Data safety

The rule Play applies: data is *collected* when it leaves the device for us or
a service working for us. What stays on the phone - photographs, downloaded
maps, the live position, files opened - is not collected, and is not declared.
Service providers acting on our behalf (Supabase, Stripe, Resend) are not
*sharing*.

**Overview answers**

| Question | Answer |
| --- | --- |
| Does the app collect or share any of the required user data types? | Yes |
| Is all collected data encrypted in transit? | Yes (HTTPS everywhere) |
| Do you provide a way for users to request that their data is deleted? | Yes |

**Data types** - each one: *Collected: yes, Shared: no, Processed
ephemerally: no, Required or optional: optional* (all of it only exists with an
account, and an account is optional):

| Category → type | Purpose | Where it comes from |
| --- | --- | --- |
| Personal info → **Email address** | Account management, App functionality | Sign-up, sign-in links |
| Personal info → **Name** | Account management | A display name, or Google's name on Google sign-in |
| Personal info → **User IDs** | Account management, App functionality | The account id; also given to Google Play to tie a purchase to the account |
| Location → **Precise location** | App functionality | The coordinates of saved pins, synced to the account. They are places the user chose rather than where the device is, but the privacy policy already treats them as personal location data, and declaring more than the minimum is the safe side of this form |
| Financial info → **Purchase history** | App functionality | Whether the account has Premium, from where, until when |
| App activity → **Other user-generated content** | App functionality | Folder names, pin names and notes, and who a folder is shared with |

**Not collected** - leave these unticked: photos and videos (they stay on the
device; only an identifier syncs), files and docs (read on the device), app
activity and interactions, web browsing, app info and performance (no crash or
analytics SDK), device or other IDs, contacts, calendar, messages, audio,
health, fitness.

### Account deletion

| Field | Value |
| --- | --- |
| Delete account URL | `https://app.halfstop.app/faq.html#close-account` |
| Can users delete some data without deleting the account? | Yes - folders and pins are deleted in the app |

The FAQ answer holds the actual *Delete* button, on the web as well as in the
app, which is what Play asks for: a way to delete the account without
reinstalling the app.

### The rest

*Government app*: no. *Financial features*: none. *Health*: no. *News*: no.

---

## Before production, if the Play account is a personal one

Google requires personal developer accounts created since November 2023 to
run a **closed test with at least 12 testers, opted in, for 14 days in a row**
before production access can even be applied for. An account registered as an
organisation - Halfstop, LLC, with a D-U-N-S number - is exempt. Play Console's
Dashboard says which applies; if it is the closed test, start it as early as
possible, because the 14 days only begin once twelve people are in.
