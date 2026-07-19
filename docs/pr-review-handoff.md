# PR Review Handoff

_Snapshot for resuming the open-PR review/merge work. Refreshed 2026-07-19
against live GitHub + PR branches (supersedes the original snapshot)._

## TL;DR

- **Everything is green and individually mergeable.** All 9 open PRs report
  `MERGEABLE / CLEAN` with passing CI as of this refresh.
- **You must merge via the GitHub UI.** The sandbox git identity cannot push
  (`git push` → 403 to `ericwang401`) and the merge API is blocked. Local
  merge-and-push is _not_ available this session.
- **The #25 conflict is gone** — it was rebased and CI is green (verified
  correct, see below). The biggest landmine from the original snapshot is
  resolved.
- **New: PR #26** (`cf doctor` preflight) appeared today, green, not in the
  original handoff. Needs a review decision.

## Local `main` state (informational — cannot push)

Local `main` `65c8351` is `origin/main` (`6ddaa8c`) + two redundant commits:
`d1d7cec` (the watchdog fix) and its merge `65c8351`. **`d1d7cec` is byte-for-byte
PR #14's head** (`fix/watchdog-fail-fast`), so nothing is lost by dropping them —
#14 goes through the normal PR flow. Optional cleanup once the handoff doc is no
longer needed: `git reset --hard origin/main` (this deletes this file, which is
currently untracked). No urgency since we can't push regardless.

## Open PRs (ground truth as of this refresh)

| PR  | Title | Status |
|-----|-------|--------|
| #26 | `cf doctor` preflight diagnostics | **NEW.** Green (36 tests). Removes old minimal doctor from `config-init.ts`. Needs review decision. |
| #25 | ISO checksum by exact URL basename | **Highest-value.** Rebased, conflict resolved, CI green. Verified correct. Ready. |
| #23 | normalize debian-12 drift + consistency test | Green. **Supersedes #15.** Carries ssh_timeout change (verified low-risk, below). |
| #22 | Windows-green CI | Green on both OSes. Merge **last**. |
| #21 | docs (setup, upload hook, cluster, coport) | Green. **Prose drift vs #18 — fix before merge** (below). |
| #20 | abort build when run lease is reaped | **DRAFT** — out of scope. |
| #18 | cluster-templates: verify before destroy | Green. Strong. Merge **before #21**. |
| #15 | boot_key_interval on remaining Linux recipes | **Strict subset of #23** (commit `a42b66b`). Plan: **close, don't merge.** |
| #14 | watchdog fail-fast | Green. Merge via UI; drop the redundant local commits. |

## Verified findings this refresh

### #25 rebase is correct ✓
`src/build/prefetch.ts`: the `{ sha256 }` literal branch short-circuits
(`if ('sha256' in checksum)`, line ~60) **before** the URL-basename/`SHA256SUMS`
logic (line ~64). The `${matched:-none}` diagnostic is guarded (line ~89) so the
literal-hash path reports `source="pinned sha256"` and never touches
`entry`/`matched`. Safe to merge.

### #18 ↔ #21 drift is REAL and specific (fix before merging #21)
Not a git conflict — the actual commits touch disjoint files (#18:
`cf-cluster-templates.sh`, `bootstrap/flow.ts`, its test; #21: `README.md` +
3 docs). The original snapshot's "24-file overlap" was a stale-base artifact
(both PRs fork from `bd3c198`, behind `origin/main`). The real coupling is prose:
- #18 rewrites `cf-cluster-templates.sh` to take an optional `[sha256]` arg and
  **recommends** `CF_UPLOAD_CMD=...cf-cluster-templates.sh {{file}} {{sha256}}`.
  Without `{{sha256}}` it emits `[warn]` and **skips** transfer verification —
  the entire point of #18. It also changes the failure log format.
- #21 `docs/usage.md` still shows `...cf-cluster-templates.sh {{file}}`
  (lines 230, 260) and describes the log as `[fail] <ip>` (line 252).
- **Action:** update #21's `usage.md` (lines 230/260 → add `{{sha256}}`;
  line 252 → match #18's per-node `[fail]` format) before it merges, or land
  both and fast-follow with a docs patch. Merge **#18 first**.

### #23 ssh_timeout change is low-risk ✓
#23 drops debian-12 `ssh_timeout` 60m → 35m. debian-12 was the **lone** Debian
outlier; debian-11 and debian-13 (and all Alma/Rocky) are already 35m. This is a
normalization to match its siblings, not a new regression singling out
debian-12. Intended per PR body.

### #23 rule-6 (byte-identical http/ payloads) is safe ✓
`tests/inject-placeholders.test.ts` creates a real `recipes/debian-test/http/
preseed.cfg` with `__PACKER_RECIPE_NAME__` and asserts substitution;
`scripts/inject-placeholders.sh` substitutes `RECIPE_NAME` into
`http/preseed.cfg`, `user-data`, `ks.cfg`. The invariant holds.

## Recommended merge order (all via GitHub UI)

1. **#25** — highest value (fixes recurring ubuntu-24.04 build failure). Ready.
2. **#18** — before #21.
3. **#23** — then **close #15**.
4. **#26** — after your review pass (green, well-tested, but new/unreviewed).
5. **#14** — via UI.
6. **#21** — only after its `usage.md` is updated to match #18's `{{sha256}}`
   contract + log format.
7. **#22** (Windows CI) — **last**, so every PR above also runs its new bash
   tests on `windows-latest`.

## Decisions still needed

1. **#15:** confirm close-not-merge (recommended — #23 contains `a42b66b`).
2. **#21 docs:** amend the PR branch, or land both #18/#21 and fast-follow?
   (A ready-to-apply diff for #21's `usage.md` can be prepared on request.)
3. **#26:** how deep a review before merge?
4. **#14:** confirm merging the GitHub PR (local commits are redundant).
