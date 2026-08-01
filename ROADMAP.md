# ROADMAP - Mobupps Unified Tools Domain & Orchestration

Owner: Michael (CGO). Implementer: Claude (chat) authors work orders; Claude Code executes in-workspace; Replit Agent is retired from this project except emergencies.
Last updated: 2026-07-31 (v2).

## Goal

Combine the four sales tools (Leadfinder, Prospector, Email Followupper, Chat Followupper) under one gateway address, then add an orchestration layer that moves prospects between the tools through APIs. Codebases stay separate. Databases and secrets never move.

## Architecture

- Gateway: `tools-gateway` app, Reserved VM, live at `https://mobupps-tools-gateway.replit.app`.
- Portal in the Dovah design language; tiles link out to each tool's current address (LINK secrets).
- Per migration: each tool gains base-path support behind an env switch, then the gateway routes `<gateway>/<tool>` to it (URL secrets). Old addresses become permanent redirects.
- Later: orchestrator service on the gateway, calling each tool's service API with internal keys.

## Domain timing

`tools.mobupps.net` and `chat.mobupps.net` become available on Sunday 2026-08-02. Nothing in the migration work depends on them: every bundle is a code change that ships inactive, and cutovers can run against `mobupps-tools-gateway.replit.app` today. When the domain lands it is attached to the same deployment and `PUBLIC_URL` is updated per tool; the old address stays alive as a redirect.

## Status board

| Item | Status |
|---|---|
| Gateway v1.2 built, godlike-audited, deployed | DONE 2026-07-30 |
| Portal launcher (4 LINK tiles) | DONE |
| Phase 0 snapshots: all five repos | DONE |
| Chat Followupper Bundle 1 (URL centralization) | DONE |
| Chat Followupper M1 (schema reconciliation) | DONE |
| Chat Followupper Bundle 2 (base-path switch) | DONE |
| Chat Followupper C1 (artifact routing) + cutover | PAUSED |
| Prospector R1 recovery (June-5 rollback incident) | DONE 2026-07-31, republished and verified |
| Prospector Bundle 1 | NEXT |
| Email Followupper Bundle 1 | NEXT (parallel - separate codebase) |
| Bundle 2 for each, then cutovers | QUEUED |
| Leadfinder migration cycle (last: live team usage, emailed links, WebSockets) | QUEUED |
| Phase 3: service APIs per tool | PLANNED |
| Phase 4: orchestrator | PLANNED |

## Migration order and reasoning

1. Chat Followupper: no team users; the practice run.
2. Prospector: already has BASE_PATH plumbing.
3. Email Followupper.
4. Leadfinder: daily team usage, emailed result links, live progress; it inherits a proven playbook.

Bundle 1 and Bundle 2 are dark by construction and may run in parallel across separate codebases. **Cutovers stay strictly sequential, one app at a time**, and the next cutover starts only after the previous app passes the smoke checklist and runs quietly for two days.

## The per-app migration cycle

1. GitHub snapshot exists (Phase 0).
2. Bundle 1: centralize every hardcoded address (links, redirects, cookies, live-progress URLs, webhook registrations, generated links) into one config module reading BASE_PATH and PUBLIC_URL, both defaulting to today's values. Zero behavior change.
3. Verify the app behaves identically.
4. Bundle 2: make the config switchable; per-app session cookie name; SPA catch-all under prefix; prefix-aware redirects. Ships inactive.
5. Test with the tool's URL secret on the gateway pointed at a staging clone.
6. Cutover: set BASE_PATH and PUBLIC_URL on production, redeploy, run the smoke checklist, point the gateway URL secret at production.
7. Convert the old address into a permanent redirect.
8. Rollback at any point: unset the two env vars, redeploy. One minute, no code changes.

## Smoke checklist (gates every cutover)

1. Log in and log out.
2. Open a deep link directly and hard-refresh on it.
3. Zero 404s on assets in the browser console.
4. Upload a file and download a file.
5. One full job with live progress end to end.
6. One generated email or message whose links point at the new address.

## Standing bundle ritual

Every bundle, without exception, in order:

1. Blast radius statement before any edit: files to be touched, behaviors affected, worst realistic failure, rollback path.
2. Surgical implementation. Minimum change achieving the scope.
3. Gates: typecheck, tests, build. All must pass.
4. Godlike audit: repeated full-diff review rounds across technical, security, and end-user framings. Any round with findings spawns fixes plus an added round. Close only on a fully clean round.
5. Smoke test: boot the app and verify the blast radius statement held.
6. Auto-fix: in-scope findings fixed and re-audited; out-of-scope findings recorded in TODO.md and left untouched.
7. Ledger entry in TODO.md with the full ritual results.

## Git safety rules

Learned the hard way on 2026-07-31, when a workspace sitting on a stale branch was snapshotted and published, dropping two months of work from production.

1. Before any snapshot, force-push, or history rewrite: print the current branch, list all local branches with their latest commit dates, and confirm the checked-out branch is the newest lineage. If another branch is ahead, stop and ask.
2. Never force-push without first pushing the current tip under a second name (branch or tag) so it survives.
3. Before any push: scan tracked files for credentials and database dumps, including `*.sql`, `*.dump`, and `client_secret*.json`.
4. Never use a GitHub push-protection unblock link. Remove the secret instead, and rotate it.
5. Code transport is git only. Manual file export between Repls is forbidden.

## TODO.md ledger

Every repo carries a TODO.md at root. Claude Code records every task there: completed bundles with ritual results, out-of-scope findings, deferred items, and external registrations discovered (webhooks, OAuth redirect URIs). Append-only history plus a live open-items section.

## What never moves

Databases stay in their apps. Secrets stay in Replit Secrets per Repl. Background jobs and schedulers stay where they run. The gateway holds no tool secrets.
