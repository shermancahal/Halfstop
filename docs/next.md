# Next iteration

Things asked for and not yet built, with enough of where they go that whoever
picks one up starts in the right file.

## A date picker for the Photography section

Asked for 2026-10-03. Let somebody choose the day the Photography section
works out, instead of always today. Planning a sunrise for next Saturday, or
the light at a spot in late October, is the reason the section exists.

Where it goes:

- `skySection(position)` in `assets/js/viewer.js` sets `const date = new Date()`
  and hands that date to everything under it: `sunTimes`, `lightPhases`,
  `dayBar`, `lightHero` and `skyPanels` (Light, Moon, Milky Way, Aurora,
  Eclipse, Fog). Most of the work is a chosen date in place of that line, and
  re-rendering the section when it changes.
- The comment above the heading says a date was taken out of the header
  because "it invited the question of whether it could be changed - which it
  cannot". That comment goes, and the date comes back as the control.
- `dayBar` draws a "now" marker. On any day but today it should not be drawn.
- A native `<input type="date">` is the picker: the trip planner already uses
  one (`trip-date`), it is the platform's own calendar on iOS and Android, and
  it needs no library. Beside it, "Today" to come back, and perhaps arrows for
  the day before and after.
- Worth deciding while there:
  - Whether the chosen day sticks while moving between pins (likely yes, for
    the session), or resets to today on each.
  - Whether a pin in a folder with trip dates opens on the trip's first day.
  - Whether a shared pin link carries the day (`&d=2026-10-24`), so "be here
    at sunrise on this day" can be sent.
- Times are shown in the device's time zone: `clockTime` is
  `toLocaleTimeString` with no `timeZone`. So a pin in Utah, planned from
  Indiana, shows Indiana times. A planning tool makes that matter more;
  showing the pin's own zone (or naming the zone beside the times) belongs
  with this.
- Tests: `test/sky.test.mjs` covers the calculations; the date only needs a
  smoke check that changing it changes the sunrise shown.

## The Android testing banner

Taken down 2026-10-02 while the open test was in Play's review. To bring it
back, set `banner: true` in `SITE.androidApp` in `assets/js/config.js`. When
the app is public, set `testing: false` instead, and reword the roadmap entry
and the FAQ answer (`faq.html#android-app`), which both say "testing".
