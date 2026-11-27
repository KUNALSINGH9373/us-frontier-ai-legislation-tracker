# US Frontier Law: owner's handbook

Written 26 Nov 2026. For the owner. No programming knowledge needed.

The site: https://usfrontierlaw.com

Other guides:
- `pipeline/README.md`: the technical guide (for a developer).
- `ACCOUNTS-AND-COSTS.md`: every account, key, limit and cost.

---

## 1. What the site is

US Frontier Law tracks US laws and proposals about frontier AI (the most powerful AI models). It covers federal and state bills,
laws, executive orders, agency rules, lawsuits and related news.

Every fact on the site should come from an official source: Congress.gov, a state legislature, the Federal Register, a court
docket, or a government press release.

## 2. What the automatic update does

A program (we call it "the pipeline") runs on GitHub every 4 hours. It:

1. reads the official sources,
2. finds what changed,
3. updates the site's data,
4. saves the change to the website, and
5. sends you a short report on Telegram.

Some steps use AI (Claude). AI never publishes on its own word. Code checks every quote and number against the official
text, a second AI model reviews the work, and each AI step only publishes while its accuracy test passes (see section 4).

### When it runs

The schedule is in `.github/workflows/update.yml`. Times are UTC (London winter time).

| Schedule | Times (UTC) | What happens |
|---|---|---|
| Regular | 00:17, 04:17, 08:17, 12:17, 16:17, 20:17 | The update always runs. |
| Backup | 02:47, 06:47, 10:47, 14:47, 18:47, 22:47 | Runs only if no update has succeeded in the last 3 hours. |

Why a backup? GitHub sometimes skips or delays a scheduled run, and a run can fail. The backup checks GitHub's own list of past
runs (`pipeline/lib/backup-due.mjs`). If a run succeeded less than 3 hours ago, the backup does nothing. If not, or if the list
cannot be read, the backup runs the update. Two runs never happen at the same time.

You can also start a run by hand on GitHub (Actions → update → Run workflow). A hand-started run is a **dry run** by default:
it reads and compares, sends a report, and saves nothing. Untick "Dry run" to make it a real run.

### One run, step by step

This is the real order, from `pipeline/update.mjs`.

0. **Before anything.** If the last successful check is more than 12 hours old, a ⚠️ warning goes to Telegram first. Then the
   accuracy gate decides which AI switches may publish in this run (section 4).
1. **Make a working copy.** Every step writes to a private copy of the data. The real site data is changed only at the very end,
   all at once, and only if every check passes.
2. **Grab the official sources.** Congress.gov (federal bills), the Federal Register (orders and rules), and LegiScan (state
   bills). It fetches only what changed since last time.
3. **Compare.** For each source, code compares the official record with the site. Each item is "new bill", "real change",
   "small change" or "no change". Only new bills and real changes go further.
4. **AI step (new bills).** For possible new bills, the AI writer reads the whole bill and drafts an entry. An independent AI
   reviewer checks it. A scope check decides if the bill belongs on the site.
5. **Official facts written by code ("Tier A").** New dated actions (hearings, votes, signings), status changes and cosponsor
   counts are written by code, in fixed wording, from the official record. No AI. If the record and the entry disagree on
   something code will not overwrite, the report says so.
6. **New bills ("Tier B").** Drafts that passed every check are added, at most 3 per run.
7. **Held items.** Items a check refused earlier are tried again.
8. **Court dockets.** New filings in the tracked federal lawsuits, trial and appeals courts, are read from CourtListener
   (`pipeline/config/courts.json`). Orders, judgments, opinions and appeals become dated events. Every court case on the site
   that cites a CourtListener docket must be followed, or listed in `_not_followed` with the reason (state-court cases, which
   CourtListener does not carry); a pull request check enforces this.
9. **End of Congress.** From 3 Jan 2027, pending federal bills of the 119th Congress are marked as died (section 6).
10. **End of state sessions.** Pending state bills are marked as died when their session is over (section 6).
11. **Self-correction.** Once a day, up to 3 entries are re-read against their bill text. A reader AI lists mistakes, a second AI
    must agree, and code checks the quotes. Only then is a field fixed.
12. **Page fields.** The short texts at the top of an entry page (one-line summary, "In 30 seconds", Key facts) are written or
    refreshed for up to 3 entries. Each field is checked by code and a reviewer AI.
13. **Links.** Links between entries (for example "sponsor of") are proposed. Only links proved by an official record are added.
14. **News.** News feeds and official records are read. News items from official records are written in fixed wording and
    checked by an independent AI review before they are added. Leads that are not yet on the site are kept in an "open leads"
    list. Once a week this step also runs a completeness check (an AI web search for anything the site is missing). Each open
    lead is read by an AI (role `lead_matcher`): business news, market reactions, commentary and similar noise is closed with the
    reason; a lead the site already has is closed as covered. What is left is raised on the Watch list until it is covered or
    30 days pass. A possible government request to an AI developer is never closed by the AI.
15. **Lawsuits.** An official press release announcing a frontier-AI lawsuit can become a new lawsuit entry.
16. **Press-based news.** A story becomes a news item if an official source confirms it, or two independent approved outlets
    report it.
17. **In the press.** Links to good outlets' stories about one entry ("In the press" on the entry page). Headline, outlet, date
    and link only.
18. **Final check.** The whole run is checked against the data as it was at the start: schemas, cross-file checks, the per-run
    limits, and a "site check" that the site still builds and nothing changed that the run did not mean to change. Anything a
    check refuses is left out and held for later. The rest goes ahead.
19. **Save.** The new data is copied to the live site files (`web/data/v2/` and `docs/data/v2/`, which must be identical).
20. **Commit and push.** The change is saved to the `main` branch on GitHub. The site updates a few minutes later. If someone
    else changed the data or the pipeline during the run, this run's change is dropped and the next run starts fresh.
21. **Telegram report.** Always sent, even when the run failed.

If any step fails in a way the run cannot explain, **nothing** is saved (except the counters of money and LegiScan queries
really spent). The next run starts from the same point.

---

## 3. The switches (`pipeline/config/publish.json`)

This file holds every switch. Values below are as of 26 Nov 2026.

### 3.1 Publishing switches (`auto_publish`)

"On" means: this step may publish **if its accuracy gate passes** (section 4). "Off" means: it never publishes. While off,
most of these steps spend no AI money and only report what is waiting.

| Switch | Now | What it controls | When on | When off |
|---|---|---|---|---|
| `new_entries` | **on** | New bills found by the pipeline | Up to 3 new bill entries per run, after the writer, reviewer and scope checks | New bills are only listed in the report as "spotted" |
| `relationships` | **on** | Links between entries | Links proved by an official record (sponsor links) are added | Links are only listed in the report |
| `news` | **on** | News items from official records | Items that pass the independent review are added to the News page | Items are worked out and reported, not published |
| `page_fields` | **on** | Short texts at the top of entry pages | Up to 3 entries a run get them written | No AI spent; the report says how many pages wait |
| `press` | **on** | "In the press" links on entry pages | Checked links are added (max 5 per entry) | No AI spent |
| `lawsuits` | **on** | New lawsuit entries from official press releases | Writer + independent reviewer; every fact quoted from the release | No AI spent; releases wait in the open-leads list |
| `press_news` | **on** | News from press reports (official confirmation or two approved outlets) | Writer + reviewer; labelled "From press reports" or "From the official release" | No AI spent; stories stay open leads |
| `mechanism`, `thresholds`, `penalties` | off | Left from an older design | No effect today (the new-bill method in use does not read them) | Leave them off |

Note on `new_entries`, `lawsuits` and `press_news`: each publishes only while a paid test report made by the current code shows
zero wrong (section 4). After any pipeline code change they stay off until those tests are re-run.

### 3.2 Gate override (`gate_override`)

An owner's written decision to let a switch publish **without** a passing test report. None is set now: the one for
`new_entries` (31 Oct 2026) was removed on 26 Nov 2026, when that switch passed its own tests. If one is ever set, every run
report reminds you of it, all other checks still run, and deleting its line from `gate_override` restores the normal gate.

### 3.3 Other settings

| Setting | Now | What it does |
|---|---|---|
| `max_entries_changed_per_run` | 15 | At most 15 entries may change in one run. More than that is treated as odd: the extra entries wait for later runs. |
| `max_new_entries_per_run` | 3 | At most 3 new entries per run. The rest wait. |
| `new_bills_gate.min_items` | test 5, unseen 5 | The new-bills test may cover just 5 bills of each test set (to keep the paid test small). Remove a number to require the whole set. |
| `news_from_official_actions` | false | An older way of writing news for each official action. Must stay off: the news gate refuses to pass while it is on, so the same action is not written twice. |
| `copy_to_docs` | true | Copy the data to `docs/data/v2/`, which is what the live site serves. Must stay on. |
| `eval_bar` | 1 / 0 / 1 | The bar for the old field test (pass rate 100%, 0 unsupported, 100% scope agreement). Set by the owner. |
| `ai_step.enabled` / `max_items_per_run` | true / 10 | The AI step for new bills and changes; at most 10 items per run. |
| `self_correction` | on, once a day, 3 entries, recheck after 30 days, 3 retries | Re-reads entries against their bill text and fixes confirmed errors. |
| `page_fields.enabled` / `max_entries_per_run` | true / 3 | How many entry pages get their short texts per run. |
| `press.enabled` / `max_age_days` / `max_checks_per_run` | true / 14 / 8 | "In the press": stories up to 14 days old, at most 8 checks per run. |
| `courts.enabled` / `max_requests_per_run` | true / 12 | Court dockets; at most 12 CourtListener requests per run. |
| `news_leads.enabled` / `max_age_days` | true / 14 | Reads news feeds; items up to 14 days old. (`max_drafts_per_run` and `max_rounds` are no longer used.) |
| `news.ai_writer` | false | News cards are written from fixed, hand-checked phrases, not by AI. |
| `links` | (note only) | Explains the links step. |
| `notify.telegram` | true | Send the Telegram report after every run. |

The weekly completeness check has no block in this file, so it uses its built-in defaults: once every 7 days, looking back 10
days, at most 10 web searches.

AI cost limits are in a different file: `pipeline/config/models.json` (see `ACCOUNTS-AND-COSTS.md`).

---

## 4. The accuracy gate (`pipeline/eval/gate.mjs`)

Every AI switch has its own test set: real past cases with known right answers, plus planted mistakes that must be caught.

A switch may publish only when **its latest recorded test shows zero wrong, and that test was made by the current code.**

"Made by the current code": each test report carries a fingerprint of the whole `pipeline/` folder. Any change to the
pipeline code or settings makes every old report stale. A stale report does not count, so the switch is treated as off.
(Turning a switch on or off, or the gate override, does not change the fingerprint.)

What this means for you:
- **News, page fields, press links and links** use free tests (code only). The pipeline re-runs them by itself at the start of a
  run when they are stale. You do not need to do anything.
- **New bills, lawsuits and press-based news** use paid tests (they call the AI, about $1–3 each). After a code change, a
  developer must re-run them, or the switch stays off. The unseen new-bills test is run by the owner (its answers are kept
  away from the developer).
- If a test fails **every** case, the test itself is probably broken. The report then says so on every run (see "broken
  measures" in section 5).

The gate never changes `publish.json`. It only decides, for each run, which switches count as on. The report says which
switches the gate turned off and why.

---

## 5. Reading the Telegram report

Code: `pipeline/report/html.mjs` (the formatted message) and `pipeline/report/format.mjs` (the plain-text version, sent if
the formatted one fails).

### 5.1 The colour at the top

| Top | Meaning |
|---|---|
| 🟢 Update complete | All fine. If nothing changed, the message is sent silently. |
| 🟡 Update complete | It worked, but something needs a look (a ⚠️ line, an item on hold, or news publishing is off). |
| 🔴 Update failed | The run stopped. It shows the step and the exact error. Nothing was changed. The next run starts from the same point. |

### 5.2 The parts (in order)

1. **Bills updated (n)**: entries that changed, with their new status line.
2. **New bills added (n)**: new entries published.
3. **New bills spotted (n)**: possible new bills not published (yet).
4. **Self-check (n fixed)**: entries re-read against their bill text and the fields corrected.
5. **Page fields (n written)**: entry pages that got their short texts.
6. **In the press (n added)**: press links added.
7. **News events / News items**: news from official records, and whether it was published.
8. **Possible informal requests to developers**: news leads that may be a government body asking an AI developer about a
   model (section G.4 of the site). Check these by hand.
9. **News leads**: news stories found but not published.
10. **Numbers**:
    - 💰 **AI cost**: this run.
    - 📅 **This month**: AI spend so far this month, out of the $50 limit, with the percentage.
    - 🔎 **Free queries**: requests to the free official sources (Congress, FedReg, LegiScan).
    - 🏛 **LegiScan month**: LegiScan queries used this month, out of the monthly cap.
    - 📰 **News publishing**: on, or OFF with the reason.
11. **⚠️ Watch**: items on hold, then the watch lines below.

### 5.3 Every watch line, and what to do

Lines with ⚠️ need attention. Lines with no icon are for information. Lines starting ℹ️ are notes.

"Nothing" in the last column means: the pipeline retries by itself. Act only if the same line keeps coming back for days.

| Line (short form) | What it means | What to do |
|---|---|---|
| ⚠️ The monthly AI limit is reached: AI work is paused until next month. | AI spend hit $50 this month. Official facts still update; new bills, news review, page fields, self-correction etc. wait. | Nothing, unless you want to raise the limit (see section 7.3). |
| ⚠️ AI spending is at N% of the monthly limit. | Spend passed 80% of $50. | Nothing. Watch it. |
| ⚠️ LegiScan queries are at N% of this month's limit | Over 80% of the 10,000 LegiScan monthly cap is used. At the cap, LegiScan is skipped until next month. | Nothing usually. If it happens early in the month, ask a developer why. |
| LegiScan this month: N of 10,000 queries | Information only (text report). | Nothing. |
| ⚠️ The [news event / news writer / page-fields / press / links / new-bills …] measure failed every case … the measure itself is probably broken | A test fails 100% of its cases. Almost always the test is broken, not the output. What it gates stays off. | **Act.** Ask a developer to fix the test. It repeats every run until fixed. |
| ⚠️ [Source] stopped early and will carry on next run. | A source hit its per-run request limit. | Nothing. |
| ⚠️ N items had a read error while checking sources. | Some official records could not be read. | Nothing. They are read again next run. |
| ⚠️ N items on hold: … (in the formatted report, listed under Watch) | A check refused an item. It is left out and the rest is published. It is retried (every run for a day, then daily). After 14 days it is dropped with a line saying "expired, needs attention". | Nothing at first. **Act** if you see "expired, needs attention": ask a developer to look at the reason. |
| ⚠️ The AI step did not run: … | No AI this run: e.g. the AI key is missing or the monthly limit is reached. | If the reason is a missing key, **act**: check the `ANTHROPIC_API_KEY` secret. |
| ⚠️ Self-check corrections were not written (a stop rule failed …) | A correction broke a rule, so nothing was written. | Nothing. Retried next run. |
| ⚠️ Self-check: … | A problem in the self-correction step. | Nothing unless it repeats for days. |
| ⚠️ N news feeds could not be read: … | Some news feeds failed. The others were read. | Nothing. If one feed fails for weeks, a developer may remove it. |
| ⚠️ News items were not written (a stop rule failed …) | News broke a rule, so none were written. | Nothing. Retried next run. |
| ⚠️ News: … | A problem in the news step. | Nothing unless it repeats. |
| ⚠️ N tracked rules or orders may have changed: a new Federal Register document uses revoke / amend / rescind wording about … The entry's description may need updating. | A new Federal Register document may change a tracked rule or order. Code records the facts, but the entry's description is not rewritten. | **Act.** Read the Federal Register document and update the entry's text if needed. |
| ⚠️ N entries disagree with the official record (not written over; the entry needs checking): … | The official record says something different from the entry (a date, or a cosponsor total that went down). Code never overwrites this. | **Act.** Check the entry against the official record and fix whichever is wrong. |
| ⚠️ The weekly completeness check did not run (…); it is tried again next run. | The weekly AI web search failed. | Nothing. |
| ⚠️ N news leads about a possible tracked development are still not on the site … (and "possible informal government requests, section G.4") | Stories that may matter are still not covered by an entry or news item. Each lead ends covered, rejected with a reason, or raised here until it expires. | **Look.** Decide if the site needs an entry or news item. G.4 items always need a person to check. |
| ⚠️ The independent review refused N news items; not published | The AI reviewer found a problem in a news item. It was not published. | Nothing. This is the safety net working. |
| ⚠️ N news items could not be reviewed (…) and wait for a later run. | The review could not run (e.g. AI error). | Nothing. |
| N pending federal bills marked as died at the end of the Congress, each checked against its Congress.gov record: … | Information (from 3 Jan 2027). | Nothing. |
| ⚠️ End of Congress: nothing was marked (a stop rule failed …) | The end-of-Congress change broke a rule. | Nothing. Retried next run. |
| ⚠️ N federal bills from an ended Congress not marked as died: … (reason) | The step could not mark these: no Congress.gov id, a sponsor may have introduced the announced bill, or the section has no "failed" status. | **Act.** Read the reason. Usually the entry needs its Congress.gov id, or a person must decide. |
| ⚠️ End of Congress: N records could not be read (…); tried again next run. | Congress.gov did not answer. | Nothing. |
| End of Congress: N more bills will be marked on the next run (per-run limit). | Information: 15 entries per run at most. | Nothing. |
| N pending state bills marked as died at the end of their session … | Information. | Nothing. |
| ⚠️ End of state sessions: nothing was marked (a stop rule failed …) | Broke a rule. | Nothing. Retried. |
| ⚠️ N state bills from an ended session not marked as died: … | E.g. the record lists no actions, or the section has no "failed" status. | **Act** if it repeats: check the entry by hand. |
| ⚠️ End of state sessions: N LegiScan reads failed (…); tried again next run. | LegiScan did not answer. | Nothing. |
| N lawsuit entries added from official releases … | Information (only when `lawsuits` is on). | Nothing. |
| ⚠️ N lawsuit releases not published (…) | The writer or reviewer refused them. | Nothing usually. Check if the lawsuit matters and add it by hand if needed. |
| ⚠️ N lawsuit releases could not be read (…); tried again next run. | The release page failed (up to 3 tries). | Nothing. |
| ⚠️ N lawsuit releases wait: … | The lawsuit step could not run for a reason other than "switched off" (e.g. monthly AI limit). | Nothing. |
| N news items added from press reports or official releases … | Information (only when `press_news` is on). | Nothing. |
| ⚠️ N press-based news items not published (…) | The checks or reviewer refused them. | Nothing. |
| ⚠️ Press-based news did not run: … | It could not run for a reason other than "switched off". | Nothing unless it repeats. |
| ℹ️ auto_publish.X is on in config/publish.json but treated as OFF this run: … | The gate turned a switch off (stale or failing test). | Nothing for free tests. For new bills / lawsuits / press news, ask a developer to re-run the paid test. |
| ℹ️ auto_publish.new_entries is ON by owner override … | Reminder of the override (section 3.2). | Nothing, unless you want to remove the override. |
| ℹ️ self-tests on this run's code and data, all 0 wrong: … | The free tests were re-run on this run's data and all passed. | Nothing. |
| ⚠️ … self-test on this run's code and data: N wrong of N cases (… off this run) | A free test found a wrong answer, so that switch is off for this run. | Act only if it repeats on the next runs: ask a developer. |
| ⚠️ N news leads about a possible tracked development are still not on the site … | Leads the AI judged to be a real development that no site item covers yet. | Look at them; each closes once the site covers it, or after 30 days. |
| ℹ️ held item … expired, needs attention … | An item was held for 14 days and dropped. | **Act.** Ask a developer to read the reason. |
| ℹ️ other notes | Things like "fallback used", "court docket not read", "proposal (held, not created)". | Nothing. |

Separate Telegram messages from the GitHub workflow:

| Message | Meaning | What to do |
|---|---|---|
| ⚠️ US Frontier Law: the last successful check was over 12 hours ago (before this run). | Several runs in a row failed or did not run. | **Act** if it repeats: open GitHub → Actions → update and read the failed runs' logs. |
| ⚠️ US Frontier Law: run N was dropped because main changed data or the pipeline meanwhile … | Someone merged a change during the run. The run's result was thrown away. | Nothing. The next run starts fresh. |

---

## 6. End of Congress and end of state sessions

### 6.1 3 January 2027: the 119th Congress ends (`pipeline/publish/congress-end.mjs`)

When a Congress ends, every federal bill that did not pass dies. The pipeline does this by itself, using the date. Nothing is
marked before the Congress's last day.

From the first run on or after 3 Jan 2027:

- **Pending federal bills**: each bill's own Congress.gov record is read first. Then the entry is marked failed, with the line
  "Died at the end of the 119th Congress (Jan 3, 2027) without becoming law", and the record's last action quoted as evidence.
- **Bills that went to the President** (presented, signed, became law, vetoed): left alone. Their record decides.
- **A record that cannot be read**: nothing is written for it; it is tried again next run.
- **Announced but never introduced bills** (listed in `pipeline/config/announced-bills.json`; today: the Liccardo–Kiley
  US–China AI safety bill and the Hawley–Murphy AI Agent Accountability Act): each sponsor's Congress.gov list of bills is read.
  If none of their bills introduced after the announcement is about AI, the entry is marked "Not introduced before the end of
  the 119th Congress (Jan 3, 2027)". If one might be it, nothing is written and the report asks for the bill's Congress.gov id.
- **At most 15 entries per run** (fewer if other steps already changed entries). So it takes a few runs. The report says how
  many are left.

### 6.2 End of state sessions (`pipeline/publish/session-end.mjs`)

A pending state bill is marked failed only when LegiScan shows **both**:
1. its session has adjourned, **and**
2. a newer regular session of that state has started.

The adjourned flag alone is not enough (for example, New York bills can pass until 31 Dec, and Illinois often passes bills in
January). Nothing is checked before the calendar year after the session's last year. Bills that passed both chambers or went to
the governor are left to their record. LegiScan queries for this count on the monthly LegiScan limit.

---

## 7. What to do when …

### 7.1 The update fails (🔴)

1. Read the "Failed at" step and the error in the message.
2. Do nothing yet. Most failures are temporary (a source is down). Nothing was changed, and the next run (or the backup
   2.5 hours later) tries again.
3. If it fails **three runs in a row** with the same error, or you get the "over 12 hours" warning, ask a developer. Give them
   the Telegram message and the link to the failed run in GitHub → Actions → update. Each run's report file is kept there for
   30 days ("run-report" artifact).

### 7.2 A ⚠️ line repeats

Check the table in section 5.3. Lines that say "tried again next run" can repeat for a day or two. If the same line repeats for
more than 2 days, ask a developer to find the cause. Rule: fix the cause, do not just silence the line.

### 7.3 The monthly AI limit is reached

- AI work stops until the 1st of next month. Official facts (dates, statuses, court events, end of Congress) still update.
- Usual monthly spend is well under the limit (see `ACCOUNTS-AND-COSTS.md`). If the limit is hit, ask a developer why first.
- To raise it: change `monthly_cost_cap_usd` in `pipeline/config/models.json` (now 50). This is a pipeline change, so it goes
  through a pull request (section 7.6).

### 7.4 A site blocks automated reading

Some government sites refuse automated readers (for example nmdoj.gov, the California AG's index page, malegislature.gov).
The pipeline does not work around a refusal. It reports the read error and moves on.

What to do: nothing in the pipeline. If the fact matters, a person (or Claude in a session) finds the official page another way
(for example a web search limited to that site) and adds it by hand. If the official page cannot be read at all, leave the fact
out. Never fill it from memory or from a news story.

### 7.5 Add a bill or entry by hand

Every pending bill on the site must be followed by the pipeline, or its updates are missed. A check on every pull request
(`pipeline/schema/tracking.mjs`) refuses an entry that is not followed. In plain words:

- **A federal bill** (title starts with "H.R. 123 —", "S. 45 —" and so on): the entry must list the bill's Congress.gov id in
  `identifiers.external.congress_gov`, written like `119/hr/123` (Congress / type / number). Find it on congress.gov.
- **A federal bill that has been announced but has no number yet**: add it to `pipeline/config/announced-bills.json` with the
  Congress, the announcement date and each sponsor's Congress.gov member id. Remove it from there once it has a number.
- **A pending state bill**: add it to `pipeline/config/identifiers-legiscan.json` (its LegiScan bill id, state, session), and
  put the same LegiScan bill id(s) in the entry's `identifiers.external.legiscan`. The two lists must match exactly.

Steps:
1. Collect the facts from the official source only (Congress.gov, the state legislature, the court, the agency). Keep the links.
2. Ask a developer (or Claude in a session) to add the entry with those facts and ids. They do this on a work branch, never
   straight on `main`, using the data-edit script method in `pipeline/README.md`.
3. Open a pull request. GitHub runs the checks (`check.yml`): the tracking check, the data schemas, the site check and all
   pipeline tests. All must be green.
4. Merge the pull request. The site updates a few minutes later. From the next run the pipeline follows the new bill.

### 7.6 Turn a switch on or off

1. Open `pipeline/config/publish.json` on GitHub.
2. Change the value under `auto_publish` (`true` = on, `false` = off). Change nothing else.
3. Save it on a new branch and open a pull request. Wait for the checks to be green, then merge.
4. The next run uses the new value. Check the next Telegram report: if the gate turned the switch off, the report says why
   (often: no passing test yet).

Turning a switch off always takes effect. Turning one on only takes effect if its test passes (section 4).

Turning a switch on or off does not make the test reports stale. Any other change in `pipeline/` does.

Note: if you merge while a run is going, that run's result is dropped (a ⚠️ message says so). This is harmless; the next run
starts fresh.
