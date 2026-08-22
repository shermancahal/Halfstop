/**
 * Mapbox access token — copy this file to `token.js` and fill in your token.
 *
 * `token.js` is gitignored on purpose. A Mapbox `pk.` token is a *public*
 * token, designed to be readable in browser code, so shipping it to your web
 * server is fine and expected. Keeping it out of the repository is still worth
 * doing: GitHub's secret scanner blocks pushes that contain one, and anything
 * committed to git stays in the history long after you rotate the token.
 *
 * Restrict the token to your domains in the Mapbox dashboard (Account →
 * Tokens → URL restrictions), for example:
 *     https://shermanc8.sg-host.com/*
 *     https://americanbyways.com/*
 *
 * Leave it empty and the site runs on the open USGS / Esri / OpenStreetMap
 * basemaps with no account at all.
 */
window.ABMAP_MAPBOX_TOKEN = '';
