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

## The known gap: a state whose shape is not in the table

Indiana state routes draw as plain circles on the Mapbox-backed map and
correctly on the Protomaps one. The artwork is not the problem — `st-IN`
exists, and `statesWithShields()` lists `IN`. Indiana's shape name is simply
not in `SHIELD_MATCH`.

Any state can be in this position. The table was built from what a probe
returned for a handful of states, not from an exhaustive list, and Mapbox does
not publish one that matches what the tiles actually carry — the documented
value `us-state` may never appear at all, while `circle-white` and friends do.

## Finding the value, which is the only way to fix it

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

## Adding it

One line: put the shape name in the `LOCAL` arm of `SHIELD_MATCH`, beside
`circle-white` and the rest. Then check that a county road nearby still draws a
circle — that is the half the Leelanau probe exists to protect, and adding a
shape that unsigned roads also carry would repeat it.
