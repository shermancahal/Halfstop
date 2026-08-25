# Highway shield blanks

The real sign blanks, from Wikimedia Commons'
[Highway shield blanks of the United States](https://commons.wikimedia.org/wiki/Category:Highway_shield_blanks_of_the_United_States).

US highway markers are designs of federal and state transportation agencies and
are not subject to copyright; Commons hosts these as public domain. They are
reproduced here at map-icon size.

## What is here

`XX-narrow.png` is 44×40 device pixels and `XX-wide.png` is 66×40, which is what
a 20px-tall icon needs at a device pixel ratio of 2. The originals are 1280–1920
pixels across — three megabytes to render forty pixels — so they are reduced by
`tools/build-shields.mjs` rather than shipped whole.

`boxes.json` records where the route number goes on each one, found by looking
for the largest rectangle of the shield's own field colour. That is why a marker
with the state's name across the top puts its number underneath: the letters are
holes in the field, and the largest rectangle avoids them.

## Rebuilding

    node tools/build-shields.mjs <directory of full-size blanks>

Writes the images here, `boxes.json` beside them, and
`assets/js/lib/shield-boxes.js` for the app to import.

## The drawn fallback

A handful of states have no blank here — Delaware, Iowa, Kentucky, Mississippi,
New Jersey and Texas among them — and are still approximated on a canvas in
`assets/js/lib/route-shields.js`. Those drawings also stand in for any shield
whose PNG fails to load, which is why they are kept for the two national
shields as well even though both now have real blanks.

Adding a state is a line in the `BLANKS` table in the build tool and a blank in
the source directory.
