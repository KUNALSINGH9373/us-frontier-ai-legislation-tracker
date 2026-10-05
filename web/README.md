# web/ — the new front end (v2 UI, v1 data)

The redesigned interface (from the Claude Design prototype, `Design1`) showing exactly the data of the current site (v1). It is independent of the current site in `docs/` and `build/`.

## Run locally

From this folder, serve it with any static server and open `Tracker.dc.html`:

```bash
python -m http.server 8768
```

Then open http://127.0.0.1:8768/Tracker.dc.html (the page must be served over http; opening the file directly will not load the data).

## Refresh the data from v1

Data is generated from v1's own sources, from the repository root:

```bash
npm run build            # v1 build: writes docs/tracker-table.csv
node web/scripts/build-data.mjs
```

`build-data.mjs` reads `docs/tracker-table.csv` (v1's row order = entry ids) and `tracker.md`, and writes `web/data/entries.json`, `news.json` and `relationships.json`. It adds what the CSV drops (signed / effective / penalties columns, every source link) and **verifies** that every entry's section, title and core-mechanism text matches `tracker.md`; it prints the problems and exits normally if any row differs.

## What is hardcoded for now

The entry ids are referenced by `tracker-lib.js` (state overrides, replay milestones, the comparison matrix `K_IDS/K_ROWS`) and the headline numbers are typed in. Both go away in the dynamic-data phase.

## Switches

- `USE_DRAFT_SUMMARIES` in `tracker-lib.js` — `false`: every entry shows the tracker's own core-mechanism text. `true` previews the 22 hand-written plain-English drafts.
- `SHOW_FOLLOW` in `Tracker.dc.html` — `false` hides the Follow button on bill pages. It only saves to the browser and nothing notifies the user, so it stays off until alerts exist.

The design-rationale and design-system pages, the RSS feed and the email signup were removed from this folder; the originals are still in the `Design1` folder next to the repository.

## Files

| File | Purpose |
| --- | --- |
| `Tracker.dc.html` | The whole app (markup, styles, logic) in one component file |
| `support.js` | Component runtime used by the prototype |
| `tracker-lib.js` | Data model and derivations (status, dates, search, map tiles) |
| `data/` | Generated data (see above) |
| `fonts/` | Plus Jakarta Sans, latin and latin-ext WOFF2 subsets |
| `scripts/build-data.mjs` | Data generator and verifier |
