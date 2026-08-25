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

## Not here

The two national shields — Interstate and US route — have no blank in this set
and are still drawn on a canvas in `assets/js/lib/route-shields.js`, as are the
handful of states with no blank (Delaware, Iowa, Kentucky, Mississippi, New
Jersey, Texas among them). Dropping their blanks into the source directory and
adding a line to the `BLANKS` table in the build tool is all it takes to switch
them over.
