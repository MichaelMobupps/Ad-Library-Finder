# ROADMAP - Mobupps Unified Tools Domain & Orchestration

Owner: Michael (CGO). Implementer: Claude (chat) authors work orders; Claude Code executes in-workspace; Replit Agent is retired from this project except emergencies.

Version 3, last updated 2026-08-02. This file is canonical. Copy it into every repo in the project, replacing whatever version is there.

## Goal

Serve the four sales tools (Leadfinder, Prospector, Email Followupper, Chat Followupper) from one gateway domain, then add an orchestration layer that moves prospects between them through APIs. Codebases stay separate. Databases and secrets never move.

## Architecture

- Gateway: the `tools-gateway` app, Reserved VM, live at `https://tools.mobupps.net` and `https://mobupps-tools-gateway.replit.app`.
- Canonical address for every app: `https://tools.mobupps.net/<tool>`. Per-app subdomains such as `chat.mobupps.net` exist only as mirrors; no further ones are bought.
- The gateway forwards to each app's `.replit.app` deployment address, never to a mobupps.net address. Those become redirect sources, and pointing the gateway at one would loop.
- Each app serves under a prefix only when `BASE_PATH` is set. Unset means today's behavior, which is the rollback path.

## Status, 2026-08-02

| App | State |
|---|---|
| Chat Followupper | Cut over to /chat. L1a (307) merged, awaiting publish |
| Prospector | Cut over to /prospector |
| Email Followupper | Cut over to /followup. L1, L1a live; L1b merged (test only) |
| Leadfinder | Bundles 1 and 2 done and dark. L2 pending, then cutover |
| Gateway | Live, routing three apps |
| Phase 3: service APIs per tool | Planned |
| Phase 4: orchestrator | Planned |

## Redirect convention, mandatory

Old unprefixed addresses must keep answering after a cutover, because links already sit in inboxes and external systems.

1. Use **307** for every legacy-to-prefixed redirect.
2. Never 308 or 301. Both are permanent and cacheable, so a cached entry survives an env-unset rollback and bounces clients to a path that no longer exists. That defeats the rollback guarantee this whole plan rests on.
3. Never 302. It permits a client to downgrade a POST to a GET, silently dropping the body.
4. Preserve the query string exactly, and prove the method arrives intact from the server's own access log rather than asserting it.
5. For machine callers such as webhooks, prefer a real first-class mount at the legacy path over any redirect, since many senders ignore redirects on POST.
6. Pin the status code with a test that boots the app, so a future edit fails a gate rather than passing silently.

## Git safety rules

Learned on 2026-07-31, when a workspace sitting on a stale branch was snapshotted and published, dropping two months of work from production.

1. Before any snapshot, force-push, or history rewrite, ask the directional question: **does another branch hold content main lacks?** Answer it with `git diff <branch> main`. Do not use tree equality between branches as the test; it goes stale the moment main takes a commit that branch lacks and produces false stops on every later order.
2. Never force-push without first pushing the current tip under a second name, branch or tag, so it survives.
3. Before any push, scan tracked files for credentials and database dumps, including `*.sql`, `*.dump`, and `client_secret*.json`.
4. Never use a GitHub push-protection unblock link. Remove the secret instead, and rotate it.
5. Code transport is git only. Manual file export between Repls is forbidden.
6. A transient "Invalid username or token" push failure is known in this environment. Retry once before treating it as blocked.

## Cutover rules

1. The app flips first, the gateway second. Adding a `*_URL` secret to the gateway while the app still serves at its root gives every tile a 404.
2. One app per hour. Republishing is rate-limited, and a rollback needs a republish.
3. Rollback is unset **plus republish**, never unset alone. `BASE_PATH` is baked into each frontend at build time.
4. Never point a public URL variable at a domain that does not resolve yet. Login breaks immediately.
5. Register every new OAuth redirect URI before the cutover, and keep the old entries.
6. Variable names differ per app. Leadfinder reads `PUBLIC_BASE_URL`; the other three read `PUBLIC_URL`. Leadfinder's boot guard refuses to start when `BASE_PATH` and `PUBLIC_BASE_URL` disagree, so set both in one edit.

## The per-app migration cycle

1. GitHub snapshot exists.
2. Bundle 1: centralize every hardcoded address into one config module reading `BASE_PATH` and the app's public URL variable, both defaulting to today's values. Zero behavior change.
3. Bundle 2: make the config switchable. Per-app session cookie name and scope, SPA catch-all under the prefix, prefix-aware redirects. Ships inactive.
4. Legacy survival order: make old addresses keep working under the convention above, before the cutover rather than after.
5. Cutover: set the two env vars, republish, point the gateway, republish the gateway, run the smoke checklist.
6. Rollback at any point per the cutover rules.

## Smoke checklist, every cutover

1. Log in, log out, log in again.
2. Open a deep link directly and hard-refresh on it.
3. Browser console shows zero 404s.
4. Upload a file and download a file.
5. Run one job end to end and watch live progress.
6. Trigger one generated link or email and confirm it points at the new address.
7. Open the old unprefixed address and confirm it lands on the app rather than a blank page.

## Standing bundle ritual

Every bundle, in order:

1. Blast radius statement before any edit: files to be touched, behaviors affected, worst realistic failure, rollback path.
2. Surgical implementation. Minimum change achieving the scope.
3. Gates: typecheck, tests, build. All pass.
4. Godlike audit: repeated full-diff review across technical, security, and end-user framings. Use a URL parser as the oracle, never string-shape checks. Any round with findings spawns fixes plus an added round. Close only on a fully clean round.
5. Smoke test, both modes where a switch is involved: dark must be byte-identical to the recorded baseline, lit must prove the new behavior.
6. Auto-fix in scope; out-of-scope findings recorded in TODO.md and left untouched.
7. Ledger entry in TODO.md with the full ritual results.

Claim only what the evidence supports. A green suite is not proof of a property the suite does not test.

## TODO.md ledger

Every repo carries a TODO.md at root: completed bundles with ritual results, out-of-scope findings, deferred items, and external registrations discovered. Append-only history plus a live open-items section.

## What never moves

Databases stay in their apps. Secrets stay in Replit Secrets per Repl. Background jobs and schedulers stay where they run. The gateway holds no tool secrets.
