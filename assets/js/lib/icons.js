/** Inline SVG icons (Feather-style, 24px grid, currentColor stroke). */

const svg = (paths, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;

export const icons = {
  layers: svg('<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>'),
  map: svg('<path d="m9 3-6 3v15l6-3 6 3 6-3V3l-6 3-6-3Z"/><path d="M9 3v15"/><path d="M15 6v15"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>'),
  /* Out of the app and into a file — distinct from `download`, which is
     something arriving from elsewhere. */
  export: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m8 8 4-4 4 4"/><path d="M12 4v12"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
  target: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>'),
  eyeOff: svg('<path d="M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 7 10 7a17 17 0 0 1-2.7 3.6"/><path d="M6.3 6.4A17 17 0 0 0 2 13s3.6 7 10 7a9.5 9.5 0 0 0 4.3-1"/><path d="M9.9 10.1a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  menu: svg('<path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  sun: svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>'),
  route: svg('<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h5a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h5"/>'),
  pin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'),
  mountain: svg('<path d="m3 20 6.5-11 4 6 2.5-4L21 20H3Z"/>'),
  compass: svg('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5.5-5.5 2 2-5.5 5.5-2Z"/>'),
  share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/>'),
  external: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  brush: svg('<path d="M9.5 14.5 3 21"/><path d="M14 4.5 19.5 10"/><path d="M7.5 12.5 11.5 8.5a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8l-4 4Z"/><path d="M17 3.5a2.1 2.1 0 0 1 3 3L18 8.5 15 5.5Z"/>'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6"/>'),
  // The same folder the panel's tab and the map's quick button already draw,
  // so "save into a folder" carries the mark of the place it saves into.
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),

  /* Details-panel section marks. A panel of eight stacked headings reads as one
     wall of small capitals; a mark per section gives the eye somewhere to land
     and makes "where is the weather" a glance rather than a read. */
  camera: svg('<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.5" r="3.5"/>'),
  cloud: svg('<path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6 1.6A3.7 3.7 0 0 0 7 19Z"/>'),
  alert: svg('<path d="M10.3 3.9 2 18.1A2 2 0 0 0 3.7 21h16.6a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5"/><path d="M12 17.2h.01"/>'),
  /* An arch over a horizon — the aurora as it is drawn on every forecast page,
     and distinct enough from `cloud` at 16px not to be mistaken for weather. */
  aurora: svg('<path d="M4 20a8 8 0 0 1 16 0"/><path d="M7.5 20a4.5 4.5 0 0 1 9 0"/><path d="M2 20h20"/>'),
  // A disc with a bite out of it and a corona beyond — the shape an eclipse
  // makes, rather than a second moon glyph that would read as the moon tab.
  eclipse: svg('<circle cx="12" cy="12" r="5.5"/><path d="M15.5 7.6a5.5 5.5 0 0 0 0 8.8" fill="currentColor" stroke="none"/><path d="M12 2.5v2"/><path d="M12 19.5v2"/><path d="M2.5 12h2"/><path d="M19.5 12h2"/>'),
  /* The band, for the Milky Way: a diagonal sweep with stars either side. */
  galaxy: svg('<path d="M4 19C7 13 12 8 20 5"/><path d="M6.5 5.5h.01"/><path d="M10 8.5h.01"/><path d="M16.5 15h.01"/><path d="M19.5 11h.01"/>'),
  crosshair: svg('<circle cx="12" cy="12" r="8"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><circle cx="12" cy="12" r="1.6"/>'),
  pencil: svg('<path d="M12.5 20H21"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5 3.5 20l1.5-4Z"/>'),
  note: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6"/><path d="M8.5 13.5h7"/><path d="M8.5 17h4.5"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 18 5-5 4 4 2.5-2.5L20 18"/>'),
  ruler: svg('<path d="M3.5 14.5 14.5 3.5a1.5 1.5 0 0 1 2.1 0l3.9 3.9a1.5 1.5 0 0 1 0 2.1L9.5 20.5a1.5 1.5 0 0 1-2.1 0l-3.9-3.9a1.5 1.5 0 0 1 0-2.1Z"/><path d="m7 11 2 2"/><path d="m10 8 2 2"/><path d="m13 5 2 2"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 15a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10.3 4.4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.6 1.2Z"/>'),
};

export default icons;
