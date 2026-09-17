# Route shields

Every numbered road on Byways Topo gets a marker drawn at runtime onto a
canvas and registered as a map image — there is no sprite sheet. Which marker
it gets is decided differently depending on which geometry is underneath, and
that difference is the whole of this document.

## Two schemas, two ways of knowing whose road it is

`assets/js/lib/byways-style.js` carries two field maps.

| | Protomaps (`byways-topo`, with an archive) | Mapbox (`byways-topo-mapbox`, and `byways-topo` with no archive) |
| --- | --- | --- |
| number | `ref` | `ref` |
| shield field | `network` | `shield` |
| what it holds | `US:I`, `US:US`, `US:IN` | `us-interstate`, `us-highway`, `circle-white`, `default` |
| what it means | **who numbered the road** | **what the marker looks like** |

That is the asymmetry. Under Protomaps a road says it belongs to Indiana's
state system, so the style asks for Indiana's marker and gets it. Under Mapbox
a road says only that its marker is, say, a white circle — so the style has to
recognise the shape name and infer the rest.

The recognising is `SHIELD_MATCH` in `assets/js/lib/route-shields.js`. A shape
name in the table draws the state's own marker. A shape name **not** in the
table falls through to `UNCLAIMED`, which is the plain circle.

## Why the fallback is a circle, and must stay one

It was the state's marker once, and that was a bug.

Probed two miles apart in Leelanau County, Michigan: M-22 comes back
`shield=circle-white`, and the county road beside it comes back
`shield=default`. With the fallback set to the state design, `default` fell
through it, and a county road wore Michigan's M. The test recording this is
*"shields: Mapbox shield values collapse onto a handful of designs"* in
`test/style.test.mjs`.

So the rule is: **name the shape, or get a circle.** Widening the fallback
instead of the table puts a state's marker on roads that state never signed.

## What the probe actually established, and what it did not

It established a **discriminator**, not a list. `default` versus a shape is the
whole finding, and it is a rule that never goes stale.

The first fix read it as a list: the shape names seen during the probe were
enumerated, and anything else fell through to the circle. That fixed Michigan
and broke every state whose shape had not been probed — Indiana among them,
drawing plain circles while `st-IN` sat registered and unused, because
Indiana's marker is not any of the shapes Michigan and Kentucky happen to use.

So the table is now read the way the probe supports. `default` has an arm of
its own and gets the circle; the shape names stay as documentation of what
turns up; and the fallback is the state's marker, because by the time a value
reaches it, `default` is already spoken for and what is left is a shape.

| shield value | design |
| --- | --- |
| `default`, or absent | circle |
| `us-interstate*` | interstate |
| `us-highway*` | US route |
| any other shape, probed or not | that state's own marker |

The absent case matters: `match` sends a null input to its fallback, and the
fallback is now the state's marker, so `SHIELD_FIELD` coalesces a missing
`shield` to `default` before the match sees it.

## Finding a specific value, when you want to know rather than infer

The rule above no longer needs the shape name to be known. This is still worth
having — to confirm what a state actually carries, or to work out why a road is
drawing a circle when it should not.

Do not guess the shape name. Ask the tiles.

**From the live site**, which needs no token handling because the page already
has one. Open `app.halfstop.app`, switch to a Mapbox-backed basemap, pan over
the state in question, and run this in the browser console:

```js
[...new Set(
  map.querySourceFeatures('composite', { sourceLayer: 'road' })
    .filter((f) => f.properties.ref)
    .map((f) => `${f.properties.ref}\t${f.properties.shield}`),
)].sort().join('\n')
```

`map` is `window.__map`. Each line is a road number and the shape name Mapbox
gave it, so an Indiana screen shows what IN routes actually carry.

**Or by Tilequery**, with a token that has `styles:tiles` scope:

```
https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/{lon},{lat}.json
  ?radius=120&layers=road&limit=30&access_token={token}
```

Pick a point on the state route itself. The `shield` property on each returned
feature is the value.

## A third component is a system, unless it is a plate

Under Protomaps a road carries `network`, and the third component decides
whether it is the state's own route or something else numbered by somebody
else.

| network | design |
| --- | --- |
| `US:I`, `US:US` | the national markers |
| `US:NY` | New York's own marker |
| `US:NY:Truck`, `US:NY:Business` | New York's marker, wearing a plate |
| `US:NY:Orange`, `US:NJ:CR`, `US:WV:County` | the county marker |

The rule is written as the complement of a closed set, and that is the whole
point. This used to look for the two words `County` and `Secondary`, which is
what West Virginia and Virginia use — and every other way of naming a county
system fell through to the state arm and wore the state's own shield. New York
names them after the county, one network per county in the state; New Jersey
writes `US:NJ:CR`. Reported as "in New York it all reads as a state route".

County names are an open set and there is no listing them. Banners are eight
words and they are already written down in `BANNERS`. So a third component
that names a banner is a plate on a state route, and a third component that
names anything else is a system of its own.

Deliberately broad: `US:TX:FM` and `US:PA:Belt` are not county systems either,
and they are not a state's numbered routes. Drawing them as something other
than the state's shield is right for the same reason.

## The border case: one state prepared, fifty askable

Registration prepares **one** state's marker — the one under the map centre.
That is right under Mapbox, where every state route resolves to `local` and
`local` is the viewport's state, so the style can only ever name the one
marker that was prepared.

Under Protomaps it is not, because a road names its own network. The style can
name any of the fifty, and a view across a state line names two. Measured: the
network expression resolves 51 distinct `st-XX` markers, while registration
for a centre in Illinois prepares exactly `st-IL`.

This is covered rather than broken. `styleimagemissing` fires, the healer draws
the shape in the same tick and swaps the real blank in when the PNG lands. But
it means a cross-border view depends on the healer for its second state, where
a single-state view does not — and the difference shows as one state's routes
carrying their proper lettered blank while the other's sit in a plain box for
a moment, or for good if the PNG never arrives.

`abmapShields()` reports this now. `elsewhere.statesWithNoMarkerReady` lists
the markers not yet prepared; absent is normal until something on screen asks
for one, so read it against what you can actually see. A state whose routes
are visibly generic *and* listed there is the healer not having finished, or
not having run.

## Images missing at startup

`Image "abmap-shield-circle-3" could not be loaded` on first paint used to be
routine and is worth knowing about, because it looks like a missing asset and
is not.

GL starts laying tiles out the moment the map is constructed, and the workers
ask for every icon those tiles name. The healer that answers that question -
`styleimagemissing` - is what makes any of this work, and it was being wired
after `await waitForStyle()`, a hundred and sixty lines later. Everything GL
asked for in between went into silence. The circle is the tell: it is drawn on
a canvas rather than fetched, so it has no reason to be missing except that
nobody had drawn it yet.

It is now wired in the same tick the map is created. If those warnings come
back, that ordering is the first thing to check, and a test asserts it.

## If a road still draws the wrong marker

A **state route drawing a circle** now means its `shield` is coming back as
`default` — Mapbox does not consider it signed. Adding the shape name will not
help, because the shape name is not what it is sending. Check the value first.

An **unsigned road drawing a state marker** means something other than
`default` is arriving for a road nobody signed. That is the Leelanau failure
returning by a different door, and the fix is another arm on the unclaimed
side, next to `default` — never widening the fallback, which is the only thing
keeping the two apart.

Adding a probed shape name to the `LOCAL` arm changes no behaviour now. It is
still worth doing as documentation of what a state carries, which is what that
list is for.
