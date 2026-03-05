---
name: submit-pr
description: Submits polished upstream pull requests from external dependency repos managed by repos.yaml. Use when asked to open a PR, submit changes upstream, push to a fork, or prepare maintainer-quality PR descriptions with testing evidence and AI disclosure.
---

# Submit PR

Use this workflow to prepare and submit a maintainer-quality PR with one clean commit.

## 1) Confirm fork via repo-manifest

1. Read `repos.yaml` and verify the target repo entry exists.
2. Ensure the repo has a writable fork:
   - `pnpm repos fork <repo-name>`
3. Confirm remotes in `repos/<repo-name>`:
   - `origin` -> fork
   - `upstream` -> source project

If the repo is missing, add it first:

```bash
pnpm repos add <owner/repo> -g <group> --clone
pnpm repos fork <repo-name>
```

## 2) Match upstream PR style

Before writing the PR:

1. Review recent merged PRs from upstream with `gh pr list`.
2. Open 2-4 similar PRs and inspect title/body/test-plan conventions.
3. Mirror upstream style for:
   - title shape
   - summary depth
   - test section format
   - reviewer-facing notes

## 3) Validate quality gates

Before committing:

1. Apply repository coding conventions (naming, formatting, patterns).
2. Run relevant lint/test/build commands for changed packages/projects.
3. If tests are targeted, justify scope in PR test plan.
4. Resolve failures before proceeding.

Minimum expectation: changed code has tests or explicit rationale when tests are not applicable.

## 4) Produce a single clean commit

Goal: one commit on PR branch.

Preferred flow:

1. Create a fresh branch from the upstream base branch.
2. Apply the full final diff.
3. Commit once with a maintainer-style message.
4. Push branch to fork with `-u`.

If work already has multiple local commits, squash to one commit using non-interactive workflow (no interactive prompts), then push.

## 5) Open PR with high-quality description

Use `gh pr create` and include:

- concise, upstream-style title
- clear summary of behavior change
- concrete test plan with commands/results
- risk/compatibility notes when relevant
- **mandatory AI disclosure** including model name

PR body template:

```markdown
## Summary

- <what changed and why>
- <important implementation detail>
- <scope boundaries and non-goals if relevant>

## Test plan

- [x] <command run>
- [x] <command run>
- [ ] <manual verification step, if needed>

## Risks

- <none> or <known risk + mitigation>

## AI Disclosure

- AI assistance used: <yes/no>
- Model: <exact model name>
- Scope of AI assistance: <implementation/tests/docs/review drafting>
- Human verification: <what was manually validated>
```

## 6) Final checks

Before sharing PR link:

1. `git status` is clean.
2. Branch is pushed to fork.
3. PR targets upstream base branch (not fork default by accident).
4. PR body includes AI disclosure with model name.
5. Return PR URL and a short checklist of what passed.
