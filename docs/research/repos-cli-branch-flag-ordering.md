---
title: 'repos CLI: `--branch` Flag Ordering Bug in `add ... --clone`'
description: 'Follow-up note tracking a regression where `pnpm repos add <slug> -b <branch> --clone` constructs `git --branch <name> clone …` (flag before sub-command) and exits with `unknown option: --branch`.'
status: draft
created: '2026-04-20'
updated: '2026-04-20'
category: investigation
related:
  - docs/research/netlify-ui-deployment-strategy.md
---

# repos CLI: `--branch` Flag Ordering Bug in `add ... --clone`

Track a small regression in `pnpm repos` where the combined `add … -b <branch> --clone` invocation fails before reaching `git clone`.

## Problem Statement

Cited in [docs/research/netlify-ui-deployment-strategy.md](docs/research/netlify-ui-deployment-strategy.md) (R15 / F9) during the Novu source clone step. Running:

```bash
pnpm repos add novuhq/novu -g ai -b next --clone
```

failed immediately with:

```
unknown option: --branch
```

`git` only emits `unknown option: --branch` when the flag is positioned **before** a sub-command (`git --branch next clone …`). The argv is being constructed in the wrong order somewhere on the `add → cloneRepo` path.

The workaround used in the original investigation was to bypass `pnpm repos` entirely and run `git clone --depth 1 --branch next --filter=tree:0 …` by hand.

## Suspected Surface

- Entry point: `add` command in [scripts/src/repos/commands.ts](scripts/src/repos/commands.ts) (around the `add` flag-parsing block, lines ~300–340).
- Clone path: `cloneRepo` in [scripts/src/repos/lib.ts](scripts/src/repos/lib.ts) at line 309 calls `buildCloneArgs({ cloneUrl, directory, branch: repo.branch, shallow: … })`. `buildCloneArgs` itself (line 280) emits the correct positional order `git clone [--depth 1] [--branch <name>] <url> <dir>`, so the ordering bug must live in the **glue** between `add` parsing and `cloneRepo` invocation, or in how `--clone` is dispatched after the manifest write.

## Reproducer

```bash
# Clean state — remove any prior novu entry from repos.yaml first.
pnpm repos add octocat/Hello-World -b master --clone
```

Expected: clones into `repos/Hello-World`, checked out at `master`.
Actual: `git --branch master clone …` → `unknown option: --branch` → non-zero exit; manifest entry remains, working tree empty.

## Recommendation

| #   | Action                                                                                                                                                                                                                             | Priority | Effort | Impact                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------- |
| F1  | Trace `add … --clone` to confirm whether `repo.branch` is being injected mid-argv. Likely fix: make sure the `--clone` branch goes through `cloneRepo` (which calls `buildCloneArgs`), not a sibling code path that mis-sequences. | P3       | Low    | Restores ergonomic flow |
| F2  | Add a unit test against `buildCloneArgs` and the `add … --clone` path that asserts argv shape `['git','clone','--depth','1','--branch','<n>','<url>','<dir>']`.                                                                    | P3       | Low    | Prevents regression     |

## References

- Originating finding: [docs/research/netlify-ui-deployment-strategy.md](docs/research/netlify-ui-deployment-strategy.md) §Findings → F9; §Recommendations → R15.
