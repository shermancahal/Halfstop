# Site copy

Every user-facing string that is not part of the map's own interface, in one
place, with where it lives and what it may honestly claim.

The positioning is photographers: someone deciding whether tonight is worth a
two-hour drive, and where to stand when they get there. Everything else the app
does — public land, forest roads, trip planning, RV advisories — is in service
of getting to the spot and knowing what is around it.

---

## Where each string lives

| String | Where | Editable in place? |
| --- | --- | --- |
| Site name, tagline, description, copyright holder | `assets/js/config.js` → `SITE` | No — config, rendered into the header and footer on every load |
| Hero, "What it does", Roadmap | `index.html`, slugs `hero`, `about`, `roadmap` | **Yes** |
| Help sections | `faq.html`, slugs `photography`, `offline`, `basemaps`, `layers`, `drones`, `directions`, `account` | **Yes** |
| `<title>`, `<meta name="description">`, Open Graph | `index.html`, `map.html`, `faq.html` heads | No |
| App name and store-style description | `manifest.webmanifest` | No |

**Editable in place** means the pencil: sign in as an address in `SITE.editors`,
press it, and the section becomes a text field. The `<h2>` stays put — the page's
anchors point at it — and everything below it is replaced. Saves land in the
`page_sections` table and are served to everybody on the next load; the
row-level policy decides whether the save is accepted, so the pencil being
hidden is convenience, not the lock.

Anything bound to the config (`#brand-name`, `#footer-name`, `#footer-tagline`,
`#footer-holder`) must stay *outside* an editable body, or the config quietly
overwrites the edit on the next load. A test enforces this.

---

## Voice

- **Say the thing, then say its limit.** "Aurora chance from NOAA" beats
  "aurora forecasting". The limit is not a disclaimer here, it is the reason to
  trust the rest.
- **Concrete over evocative.** "Golden hour lasts 34 minutes tonight" is the
  product. "Chase the light" is a stock photo caption.
- **Second person, present tense, no exclamation marks.**
- **No "seamless", "powerful", "revolutionise", "unlock", "elevate".** No
  "just" as in "just three clicks".
- **British spellings** to match the existing prose: colour, organise, centre,
  metre.
- **Never claim navigation.** The app plans and hands off; it does not give
  turn-by-turn.

---

## Names and taglines

**Name:** Halfstop · **Legal:** Halfstop, LLC · **Domain:** halfstop.app

**Tagline (live, in `SITE.tagline`)**
> Plan the light. Scout the location. Keep the spot.

**Alternates**
> The light, before the drive.
> Know the light. Find the road in.
> Where to stand, and when.
> A map that knows what the sky is doing.

**One line (25 words)**
> Halfstop is a planning map for photographers: golden hour, moon, Milky Way,
> aurora and eclipse times at any pin, over mapping that works with no signal.

**One paragraph (60 words)**
> Halfstop is a map for photographers. Drop a pin and it tells you when the
> light arrives and which way to face — golden hour, blue hour, moonrise, the
> galactic core, tonight's aurora chance, the next lunar eclipse, and the odds
> of fog by dawn. Underneath: public land, forest roads, dark-sky and weather
> layers, and regions you can download before you leave signal.

---

## Page metadata

**index.html**
- Title: `Halfstop — plan the light, scout the location`
- Description: `A planning map for photographers: golden hour, moonrise, the Milky Way's core, aurora chance and lunar eclipses at any pin, over federal, state and topographic mapping that works with no signal.`
- `og:title`: `Halfstop`
- `og:description`: `Drop a pin and Halfstop tells you when the light arrives and which way to face — then shows you the land, the roads and the weather around it.`

**map.html**
- Title: `Map — Halfstop`
- Description: `Plan a shoot on the map: light phases, moon, Milky Way, aurora and eclipse times for any pin, with public land, forest roads and weather underneath it.`

**faq.html**
- Title: `Help & FAQ — Halfstop`
- Description: keep the existing one; it describes the page, not the product.

**manifest.webmanifest**
- Description: `Golden hour, moonrise, the Milky Way, aurora and eclipse times at any pin, over topo, satellite and public-land mapping you can take offline.`

---

## Homepage

### Hero — live

> # Plan the light before you drive to it.
>
> A map for photographers. Drop a pin anywhere and Halfstop works out when the
> light arrives and which way to face — golden hour, blue hour, moonrise, the
> Milky Way's core, tonight's aurora chance, the next lunar eclipse, and whether
> the valley will fill with fog by dawn. Underneath it: federal, state and
> topographic mapping you can download before you leave signal.

Buttons: **Open the map** · **What it does**

### Hero — alternate A, the question first

> # Is tonight worth the drive?
>
> Halfstop answers that on the map, for the exact spot you are thinking of
> standing: how long golden hour runs, how much of the moon is lit and when it
> clears the ridge, whether the galactic core is up while the sky is actually
> dark, and what the fog is likely to do at dawn. No signal required — the whole
> panel is arithmetic done on your device.

### Hero — alternate B, the object

> # A map that knows what the sky is doing.
>
> Sun, moon, Milky Way, aurora and eclipse, worked out for the pin you dropped
> and drawn as lines across the ground you will be standing on. Public land,
> forest roads, dark-sky and weather layers underneath. Downloadable before you
> lose signal, because that is usually the point.

### What it does — the six cards

Headings, in order, with the one thing each must land:

1. **The light, at the pin, on the night** — the day as a bar, and the five
   tabs beside it. *Lands: precision, and that it is per-pin, not per-city.*
2. **Which way to face** — bearings drawn on the map, moved by a time slider.
   *Lands: the ridge is in the way; only a map shows that.*
3. **Federal and state mapping, stacked** — public land, Forest Service and BLM
   roads, USGS topo and imagery, light pollution and Bortle, FAA drone ceilings,
   radar and storm motion, state agency layers for thirty states.
   *Lands: breadth, and that it stacks.*
4. **The spots you keep** — waypoints with colours and icons, photographs on
   pins, folders, GPX/KML/KMZ/GeoJSON in and out, sync once signed in.
   *Lands: this is your collection, not a feed.*
5. **A map drawn to be read, not admired** — Byways Topo, unpaved louder than
   paved, shields and park symbols drawn here.
   *Lands: the custom design is a legibility decision.*
6. **It works where the signal does not** — downloadable regions with honest
   costs, save-as-picture, on-device arithmetic.
   *Lands: the promise the rest depends on.*

Full text is in `index.html`; edit it there or through the pencil.

### Roadmap

Five shipped, two next, one later. The rule for this section: **shipped means a
reader can press it today.** Anything else is Next or Later, and Later means no
date is being implied.

---

## Help page

`faq.html` opens with **Planning a shoot**, which is the section a photographer
arriving from a search result needs, and it is where the honest limits live:

- Light phases, moon and Milky Way are computed on the device, for the pin.
- Aurora is NOAA's OVATION output plus Kp, read rather than modelled here.
- Eclipses are **lunar only**. Solar is absent rather than approximated.
- Fog is a likelihood over somebody else's forecast, with the deciding
  ingredient named.

---

## Elsewhere

**App store, short**
> Plan the light before you drive to it. Golden hour, moon, Milky Way, aurora
> and eclipse times for any spot on the map — plus public land, forest roads and
> weather, downloadable for use with no signal.

**App store, long** — open with the short version, then the six card headings
above as a feature list, then the limits section. Store reviewers and readers
both respond better to a stated limit than to a fifth superlative.

**Social bio (150 characters)**
> Planning map for photographers. Golden hour, moon, Milky Way, aurora, eclipse
> — at your pin, offline. halfstop.app

**Search-result answer, if asked what it is**
> Halfstop is a web app that combines an ephemeris — sun, moon, galactic core,
> aurora, lunar eclipse — with topographic, public-land and weather mapping, so
> a photographer can pick a location and the night to be there in one place.

---

## Claims that must stay true

Copy drifts optimistic. Each of these has a reason behind it in the code, and
changing the claim means changing the code first.

| Do not write | Write |
| --- | --- |
| Eclipse forecasts | Lunar eclipses, with contact times |
| Aurora forecast | Aurora chance, from NOAA |
| Turn-by-turn directions | Plan the drive, then hand it to Apple, Google or Waze |
| Accurate trip times | The shape of a trip: stops, meals, fuel and sleep counted |
| RV-safe routing | An RV advisory, and what it cannot see |
| Download any basemap | Download the open layers and our own archive; Mapbox reserves offline for native |
| Your data is backed up | Folders live in this browser until you sign in |
| Works offline | The app opens with no network; the map needs the regions you saved |
