# US Frontier AI Legislation Tracker (2025–2026)

A primary-source audit of US state and federal bills, enacted laws, executive actions, litigation and export controls that target frontier AI developers, plus the independent-verification-organization (IVO) and AI-auditor licensing bills that form a distinct sub-category. Verified as of **September 5, 2026**.

The tracker is published as a static site from the `docs/` folder:

**https://kunalssingh.com/us-frontier-ai-legislation-tracker/** (the GitHub Pages address, `https://kunalsingh9373.github.io/us-frontier-ai-legislation-tracker/`, redirects there because the account's Pages site uses that custom domain).

`LINK-CHECK.md` records a reachability check of every link in the tracker.

## What is in this repository

| Path | What it is |
| --- | --- |
| `tracker.md` | The tracker itself, in markdown. This is the content of record. |
| `source/google-doc-export.md` | The tracker exactly as exported from the source Google Doc, untouched. Kept for provenance. |
| `build/build.mjs` | Renders `tracker.md` to `docs/index.html`. |
| `handbook.md` | The Plain-English Handbook shown on the Info tab. |
| `build/handbook.mjs` | Renders the handbook into the Info tab. |
| `build/verify.py` | Independent check, written separately from the build: parses the markdown tables and the published HTML and confirms every cell appears under its own column heading, in its own entry, in the author's column order, with its links; and that every paragraph is present. |
| `build/template.html` | Page chrome: typography, table of contents, table styling. |
| `docs/` | The generated site that GitHub Pages serves. Also carries a copy of `tracker.md` for download. |
| `LINK-CHECK.md` | Reachability check of every unique link in the tracker, with HTTP status codes. |

## Info tab

The *Plain-English Handbook for the Frontier AI Law Audit (2025–26)*, shown one chapter at a time with a chapter grid, sub-section chips, and previous/next links. `handbook.md` is the text of record and `docs/handbook.pdf` the print version. `build/handbook.mjs` renders it: glossary bullets become term cards, numbered lists become step cards, the source hierarchy a ladder, the ten rules rule cards; trailing colons on glossary terms are dropped in card headings. The build fails if any word of the handbook is missing from the page.

## Year filter

The filter row under the top bar scopes the whole tracker to a year: All time, 2023, 2024, 2025, 2026, or 2027 and later. An entry belongs to a year when it has a dated event in that year, using the same events as the timeline tab. Section counts, the sidebar, jump lists and search all follow the filter, and each matching entry shows the dated events that placed it in that year. Entries with no dated event appear under All time only. The overview's "Activity by year" chart sets the same filter.

## Table tab

Every entry as one row with the tracker's Sponsor, mechanism, threshold, status, source and confidence cells under their own headings. Sortable by section, entry, jurisdiction, status class and confidence; filterable by group, section, jurisdiction, status class, free text and the year filter; rows expand to show full cells. `docs/tracker-table.csv` is the same table as CSV.

Below the table is a cross-check against the American Action Forum's "List of Proposed AI Bills" (99 federal bills, fetched 2026-09-08, snapshot in `source/`). `build/aaf-crosscheck.json` records which bills appear in both lists, which AAF bills fall within or near the tracker's frontier scope but are not yet entries, which tracker bills AAF lacks, and caveats about the AAF list. The candidates are inputs to the tracker's verification process, not entries.

## Timeline tab

The **Changes over time** tab is a derived view. At build time, `build/events.mjs` reads every date in the tracker's date-bearing columns (Signed, Effective, Status, Introduced / status, Date) and turns each into an event with the entry it belongs to, the column it came from, the clause of text around it, and an event type inferred from the words in that clause (introduced, passed, signed, effective, referred/stalled, vetoed/failed/rescinded, litigation, deadline). Where the tracker gives only month and day, the year is taken from the same cell and the event is flagged as inferred. Hovering any mark shows the original cell text, and a table view lists every event. The tracker text is not changed by this; if a type looks wrong, the classifier is the place to fix it.

## Content policy

The published page reproduces `tracker.md` without editorial changes. The build step only converts markdown to HTML, adds heading ids for the table of contents, opens external links in a new tab, wraps tables so they scroll horizontally, and attaches CSS classes to the author's own bold confidence labels (`HIGH`, `MED-HIGH`, `MED`, `SEARCH-QUALIFIED`, `LOW`) and status classes (`[PENDING]`, `[STALLED]`, `[FAILED]`). The page shows one section at a time, with grouped navigation, a per-section jump list, search across all entries, and previous/next links; with JavaScript off, every section is shown in full. Each table row is one entry; its columns appear in the author's order, with runs of short cells grouped into a facts grid and long cells shown as prose blocks. One deliberate layout choice on the overview page: the section directory is shown first and the document's confidence key and verification note are shown after it; the text of both is unchanged. The build fails if any table cell, any link (text and URL), or any word of the markdown is missing from the HTML, and `python3 build/verify.py` re-checks placement independently.

`tracker.md` was derived from `source/google-doc-export.md` by reversing two artifacts of the Google Docs export and nothing else:

1. Markdown characters inside table cells had been backslash-escaped by the export (`\*\*Bill\*\*`); one level of escaping was removed so the author's original markdown renders.
2. The export emitted each table with an empty header row and the real header as the first body row; the real header was restored.

## Updating

1. Edit `tracker.md`.
2. Run `npm install` once, then `npm run build`, then `python3 build/verify.py`.
3. Commit `tracker.md` and the regenerated `docs/` together and push to `main`. GitHub Pages redeploys from `docs/`.

## Confidence key

Ratings apply per claim; a row's rating is the weakest load-bearing claim in the row.

- **HIGH**: checked directly against an operative primary record.
- **MED-HIGH**: strong corroboration, but a load-bearing primary record is nonpublic, inaccessible, or does not itself establish the full proposition.
- **MED**: two or more concurring reputable secondary sources; primary material does not establish the key detail.
- **SEARCH-QUALIFIED**: a date-bounded negative finding, not proof that an event does not exist.
- **LOW**: single source, or key details thin or unverified.

Legislative status changes weekly. Re-check the linked primary source before citing.
