# App Store: the listing, App Privacy, age rating and App Review

What to type into App Store Connect for the iPhone app, worked out from what
the app actually does, so it agrees with `privacy.html`, with the Google Play
answers in [play-listing.md](play-listing.md) and with itself. Apple checks the
App Privacy answers against the app and the privacy policy at review, and a
mismatch is a rejection.

The fields are in the order App Store Connect asks for them. Character limits
are Apple's; each text below is under its limit.

The in-app purchase setup is separate, in the App Store section of
[payments.md](payments.md); the build and TestFlight steps are in
[mobile-app.md](mobile-app.md) §6b.

---

## Before submitting for review

Two things in the app itself, without which App Review is likely to refuse
the first submission. TestFlight does not need either.

- **Sign in with Apple** (guideline 4.8). Required because the app offers
  Continue with Google. Section 2 of [app-auth.md](app-auth.md).
- **Buying Premium in the app** (guidelines 3.1.1 and 3.1.3(b)). Premium
  features are locked in the iPhone app, and anything an app locks has to be
  for sale in it through the App Store. The server half is built; the steps
  that come first are in the App Store section of [payments.md](payments.md).

The description below is written for the app with both in.

---

## App Information (General → App Information)

| Field | Value |
| --- | --- |
| Name (30) | `Halfstop: Field Atlas` |
| Subtitle (30) | `Scout, pin and time the light` |
| Primary category | Navigation |
| Secondary category | Photo & Video |
| Content rights | *Yes, it contains third-party content, and I have the necessary rights.* The basemaps and layers come from USGS, NOAA, NASA, the BLM and the Forest Service (US government, public domain), OpenStreetMap (ODbL, credited on the map), Esri and Mapbox (under their terms, credited on the map). |
| Age rating | 4+, from the questionnaire below |

### Age rating (App Information → Age Rating → Edit)

Answered from Apple's own definitions, which are quoted where the answer is
not obvious. The result is **4+**.

| Section | Question | Answer | Why |
| --- | --- | --- | --- |
| In-App Controls | Parental Controls | No | |
| | Age Assurance | No | |
| Capabilities | Unrestricted Web Access | **No** | Apple: "Users can navigate to any webpage within the app or freely browse the web". A link in a note opens in Safari, and Continue with Google opens Google's sign-in page and comes straight back. Neither is a browser in the app. |
| | User-Generated Content | **No** | Apple: "the broad distribution of content created by users". A folder goes to the people its owner invites, or to whoever they send a link to. Nothing is listed, searchable or shown to strangers. |
| | Social Media | No | No feed, likes, follows or discovery. |
| | Messaging and Chat | No | |
| | Advertising | No | |
| Mature Themes | Profanity, horror, alcohol, tobacco or drugs | None | |
| Medical or Wellness | Medical or treatment information; health or wellness topics | None | |
| Sexuality or Nudity | All three | None | |
| Violence | All four, including guns or other weapons | None | Wildlife management areas are land boundaries, not hunting content. |
| Chance-Based Activities | Gambling, simulated gambling, contests, loot boxes | None | |

**Made for Kids:** No. The privacy policy already says Halfstop is not
directed at children, as the Play listing's audience of 18 and over does.

---

## App Privacy (Privacy policy URL, then the data questions)

**Privacy policy URL**

```
https://app.halfstop.app/privacy.html
```

Apple's rule, like Play's: data is *collected* when it leaves the device and
we, or a service working for us, can read it for longer than it takes to
answer the request. What stays on the iPhone is not collected and is not
declared. This covers photographs, downloaded maps, the live position and the
files opened.

**Do you or your third-party partners collect data from this app?** Yes.

**Tracking:** none of it is used to track anybody. Answer *No* to tracking
for every type. There is no advertising, no analytics and no data broker.

Each type below: **linked to the user** unless it says otherwise, **not used
for tracking**, purpose **App Functionality** only. All of it exists only with
an account, and an account is optional.

| Category → type | Linked | What it is |
| --- | --- | --- |
| Contact Info → **Email Address** | Yes | Sign-up, sign-in links, folder invitations |
| Contact Info → **Name** | Yes | A display name, or the name Google or Apple gives at sign-in |
| Identifiers → **User ID** | Yes | The account id; also given to the App Store to tie a purchase to the account |
| Location → **Precise Location** | Yes | The coordinates of saved pins, synced to the account. They are places the user chose rather than where the phone is, but the privacy policy treats them as personal location data, and declaring more than the minimum is the safe side of this form, as on Play |
| Purchases → **Purchase History** | Yes | Whether the account has Premium, from where, and until when |
| User Content → **Other User Content** | Yes | Folder names, pin names and notes, and who a folder is shared with |
| Search History → **Search History** | **No** | What is typed into the search box goes to komoot's Photon, and on Premium to Mapbox, to find the place. It is sent with no account id, and we keep none of it. But they are not ours to make promises for, so it is declared, not linked |

**Not collected.** Leave these unticked:

- Photos or Videos: they stay on the iPhone; only an identifier syncs.
- Coarse Location: the phone's own position never leaves it.
- Customer Support: support is by email, outside the app.
- Browsing History, Usage Data, Diagnostics: there is no crash or analytics SDK.
- Contacts, Health and Fitness, Financial Info other than purchases, Sensitive Info, Device ID, Audio, Emails or Text Messages, Surroundings, Body, Other Data.

---

## The version page (iOS App → the version)

### Screenshots

App Store Connect requires two sets for this app, because it runs on iPad as
well as iPhone. It scales them down for every smaller device.

| Display | Size | Folder |
| --- | --- | --- |
| iPhone 6.9" | 1320 × 2868 | `docs/store/screenshots/iphone-6.9/` |
| iPad 13" | 2048 × 2732 | `docs/store/screenshots/ipad-13/` |

On the Mac, in the clone:

```
cd ~/Halfstop
git pull
node tools/build-store-screenshots.mjs --only=apple
```

It photographs the live site at each size: the same scenes as Play, plus a
seventh with a trip's folders in it. If it cannot find a browser, put
`CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`
in front of the command. Everything else about it is in
[play-listing.md](play-listing.md). Look at each picture before uploading, and
drag them into App Store Connect in number order; the first three are what
shows in search results.

### Promotional text (170)

Changeable at any time without a new build.

```
New in 1.0: color scales along the bottom of the map, pin cards that fill your phone's screen, and waypoints you can sort by name, date or distance.
```

### Description (4000)

Every feature is listed as free or Premium the way
`assets/js/lib/tiers.js` gates it. Nothing names another platform's store,
which Apple refuses in metadata (guideline 2.3.10). The subscription
paragraph and the two links at the end are what guideline 3.1.2 asks an app
with an auto-renewing subscription to say.

```
Halfstop is a field atlas for photographers. Scout a location, drop a pin, and know when the sun, the moon or the aurora will be where you need it.

TIME THE LIGHT
• Sunrise, sunset, golden hour, blue hour, moonrise and moonset for any pin
• Milky Way and aurora outlooks, and eclipse paths across the map
• Sky brightness on the Bortle scale, and light pollution seen from space

KNOW THE GROUND
• USGS topographic maps, aerial imagery, hillshade and contours
• National forest, BLM, state land, wilderness and park boundaries
• Forest road numbers and drone ceilings
• A color scale along the bottom of the map for every layer read by its colors

PIN IT
• Save waypoints into folders, and folders inside folders, by trip, by season, or by the light they need
• Sort your waypoints by name, date added, distance or folder
• Search for a place by name, from OpenStreetMap
• Open GPX, KML, KMZ and GeoJSON files, including starred places and saved lists exported from Google Maps
• Export any folder as GPX or GeoJSON, free, with or without an account
• Send a folder as a link that opens on any phone or computer
• Sync up to 100 folders and 100 waypoints between your iPhone and your computer, free

PREMIUM
For the parts that cost us money every time they are used:
• Syncing any number of folders between devices
• Inviting others to view a folder or work on it with you
• Search that also finds businesses and street addresses, from Mapbox
• Offline map downloads, for when the bars run out
• Weather layers: radar, temperature, cloud cover, wind, rain, snow, fog and storm tracks
• Trip planning with road routing
• Photographs kept with a waypoint
• State-level detail maps and extra basemaps

Premium is $4.99 a month or $49 a year in the US, as an auto-renewing subscription. A new account gets a free month first, with nothing to cancel: it simply ends. Payment is charged to your Apple Account when you confirm the purchase. The subscription renews automatically unless it is cancelled at least 24 hours before the end of the current period, and renewal is charged within the 24 hours before the period ends. Manage or cancel it in your Apple Account settings.

No ads, no analytics, no tracking.

Maps are for planning. Carry a paper map where it matters, and use your own judgement in front of the actual ground.

Terms of use: https://app.halfstop.app/terms.html
Privacy policy: https://app.halfstop.app/privacy.html
```

### Keywords (100)

Comma-separated with no spaces after the commas, since spaces count. Words
already in the name and subtitle are left out (*field, atlas, scout, pin,
light*), because Apple indexes those anyway. This one is 97 characters:

```
photography,golden hour,sunrise,sunset,moon,milky way,aurora,topo,gpx,kml,blm,public land,offline
```

### URLs

| Field | Value |
| --- | --- |
| Support URL | `https://app.halfstop.app/faq.html`, where the contact address is |
| Marketing URL | `https://app.halfstop.app/` |

### Version and copyright

| Field | Value |
| --- | --- |
| Version | The one the build printed, such as `1.0.621`. It has to match the build exactly. |
| Copyright | `2026 Halfstop, LLC` |

### App Review Information

**Sign-in required:** Yes. Use the same review account as Google Play: an
email and password, with Premium granted with no end date in Admin. Type the
email and password into the two fields here. They are not in this repository,
and should not be.

**Contact information:** your name, a phone number App Review can call, and an
email address.

**Notes** (4000):

```
Halfstop is a map for planning photography trips. Most of it works without an account: tap the map to see what is there, press the pin button to drop a pin with its sunrise, sunset and moon times, and open Layers to switch maps and overlays. The (i) beside a layer explains it.

To sign in with the review account: tap the gear at the top of the screen, then Sign in, and use the email and password above. Premium is granted on that account, so its features can be seen without a purchase: weather layers, offline map downloads (the download button at the top of the screen), trip routing, photographs on a waypoint, state detail maps, extra basemaps, place and address search, unlimited sync and folder invitations.

Premium is sold in the app as an auto-renewing subscription, monthly or yearly, through the App Store. To see the purchase, sign out, create a new account with any email address, then tap the gear and Account: the plan and its two prices are on that page.

Location is used only to centre the map on the user and to measure the distance and bearing to a pin. It is not sent to us or stored anywhere.

To delete an account: gear, then Account, then "Read what it removes and close the account", then the Delete button at the end of that answer. The same button is in Help, under "Closing your account".
```

---

## After it is live

- **What's New** (4000) for each update: the newest entry from the FAQ's
  What's new, cut to its first lines.
- **The privacy policy** names Stripe and Google Play as who takes payment.
  It gains Apple the day the App Store purchase ships, in the same change.
- **Universal links**, so links to app.halfstop.app open the app, need the
  Team ID in an `apple-app-site-association` file. See "Later: universal
  links" in [app-auth.md](app-auth.md).
