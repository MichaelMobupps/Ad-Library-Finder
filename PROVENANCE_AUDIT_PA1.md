# Provenance Audit - Order PA-1

Run this in every one of the four app repos, one at a time: Prospector, Leadfinder, Email Followupper, Chat Followupper. Paste the block below the divider line into that repo's Claude Code session, replacing the SYMPTOM ANCHORS section with the one for that app from the appendix.

The question this answers is not "is the code correct". It is: **is the code running in production the newest code that has ever existed for this app, or has content been lost?**

---

Diagnostic order PA-1: provenance audit. Read-only. Change no files, no database rows, no secrets. Do not commit, deploy, or publish. Report and stop.

Context: during a July and August migration, two sibling apps were found running code months older than their newest work. In one case a publish shipped June 5 code on July 31; in another, main sat 89 commits and 14,535 lines behind the branch holding the real work. Both were found by accident. Bugs fixed months ago have now reappeared in production, and the interface looks current while the behaviour looks old. Establish, from artifacts rather than reading, whether any content that once existed is missing today.

STANDARD OF PROOF. Every claim rests on a commit hash, a file diff, a build artifact, a stored row, or a command output you ran. The words likely, probably, presumably, appears to and should are banned from conclusions. Absence of evidence is reported as absence of evidence, never as absence of a problem. Do not reassure. If you cannot prove something either way, say exactly what would settle it.

PHASE 1 - EVIDENCE INVENTORY. Gather before concluding anything.
1. Every ref that exists or has existed: local branches, remote branches, tags, the reflog, stashes, and dangling or unreachable commits from git fsck --lost-found. For each, its tip date and one-line subject.
2. Whether any remote other than origin is configured, and what it holds.
3. The full commit history of main with dates, and any period where main received no commits while other refs did.
4. Every "Published your App" or platform-authored commit, with dates, since those mark what was actually deployed.

PHASE 2 - MAXIMAL CONTENT SEARCH. This is the core test.
5. For every ref and every dangling commit found in phase 1, answer directionally: does it contain content that HEAD lacks? Answer with git diff <ref> HEAD and report insertions and deletions per ref. Do not use tree equality; it goes stale the moment either side moves.
6. Build the set of every file path that has ever existed in any commit on any ref, then subtract the paths present at HEAD. Report every path that once existed and is absent now, with the last commit that contained it and its date. Distinguish deliberate deletions from disappearances.
7. For the largest source files in the app, compare line counts at HEAD against the maximum line count that file ever reached, and report any file materially smaller now than at its peak, with dates.
8. Report any commit whose message suggests a fix, feature or version bump that has no corresponding content at HEAD.

PHASE 3 - WHAT IS ACTUALLY DEPLOYED.
9. Determine which commit the live deployment was built from, and when. If the repository cannot tell you, say so and state what would: name the pane, log or endpoint that holds the answer.
10. Compare the deployed build against a fresh compile of HEAD. Report whether they match, and if they differ, in what.
11. If this app builds more than one artifact, do this per artifact. A frontend built from newer source than the server it talks to would present exactly as "the interface looks current but the behaviour is old". Prove for each artifact which source it came from.
12. Report every environment variable and deployment secret the running app reads, and whether any of them changes behaviour in a way that could mimic a rollback, such as a limit, a cap, a model name, a batch size or a feature flag.

PHASE 4 - TIME CAPSULE RECONSTRUCTION.
13. This repo contains dated bundle archives, patch zips and backup directories from earlier work, including under attached_assets and any *-backup or .backups directories. Inventory them with dates.
14. Pick the newest such bundle that predates the migration and extract it to a scratch directory. Diff its source against HEAD. Report every function, constant, route, guard or file present in that bundle and absent or reverted at HEAD.
15. Repeat for at least two more bundles spanning different months, so a regression can be dated rather than merely found.
16. This is the strongest available evidence, because those bundles are what was actually shipped at the time. Treat any difference as a finding requiring explanation, not as noise.

PHASE 5 - SYMPTOM ANCHORING. Work backwards from observed behaviour.
17. For each symptom listed below, locate the exact code that controls it: the constant, limit, loop bound, filter condition or API parameter. Name the file and line.
18. Walk that specific code's history with git log -p over the file and the surrounding function, across all refs and not just main. Report every value it has ever held with dates.
19. State whether today's value or logic is the newest that ever existed, or an older one. If older, name the commit that introduced the newer version and the commit or event that removed it.
20. If the controlling code has never changed, say so plainly, because that disproves the rollback hypothesis for that symptom and points elsewhere.

SYMPTOM ANCHORS: replace this section with the anchors for this app from the appendix.

PHASE 6 - VERDICT.
21. State one of three verdicts, with the evidence that supports it: content has been lost, no content has been lost, or the evidence available cannot settle it and here is what would.
22. If content has been lost, list exactly what, from which commit, and the smallest safe way to restore it. Do not restore anything in this order.
23. Record everything in TODO.md, including the file-path set from step 6 and the bundle inventory from step 13, so a later order does not repeat this work.

Never modify production data. Never touch the running workflow. Never dispatch email or start a real scraping job.

---

## Appendix: symptom anchors per app

### Prospector

- Contact lookup returns very few contacts for large companies. Reported: lazada.com, a company of roughly 22,000 employees where Apollo lists hundreds of contacts, returns four. Find every limit between the Apollo request and the stored contacts: per-page size, page count, maximum contacts per company, role or seniority filters, dedup rules, and any cap applied after enrichment. Report each value and its history.
- Only one email is drafted where more were expected. Find what decides how many drafts a company produces.
- A 125-row list auto-filtered to 8 raced to 80% in under a second. Find what the progress figure counts, what happens to filtered rows, and whether they are processed, skipped or marked complete.

### Leadfinder

- Compare current discovery limits, per-source page counts, keyword sets, country lists and enrichment budgets against the values in the July bundles. The July work rebuilt the Google Ads engine, so confirm that rebuild is present at HEAD.
- Confirm the job pipeline stages at HEAD match the newest version, particularly anything governing how many advertisers or apps a run examines.

### Email Followupper

- Confirm the July doctrine, nativeness and critic work is present at HEAD, including the v4 lint stages, the discourse marker autofix and the volume calibration, all of which appear in dated bundles.
- Confirm the send caps, scheduling window and bounce handling match the newest versions rather than an earlier one.

### Chat Followupper

- Confirm the July channel register work is present, including the four Telegram rule constants and the future-channels comment.
- Confirm the prospect and follow-up generation stages match the newest bundles rather than earlier ones.
