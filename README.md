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
| `build/verify.py` | Independent check, written separately from the build: parses the markdown tables and the published HTML and confirms every cell appears under its own column heading, in its own entry, in the author's column order, with its links; and that every paragraph is present. |
| `build/template.html` | Page chrome: typography, table of contents, table styling. |
| `docs/` | The generated site that GitHub Pages serves. Also carries a copy of `tracker.md` for download. |
| `LINK-CHECK.md` | Reachability check of every unique link in the tracker, with HTTP status codes. |

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
