---
name: pr-review-coordinator
description: Orchestrates PR review issue resolution by parsing review comments and dispatching to pr-issue-fixer subagents. Use when given a PR review summary, list of issues to fix, or when the user pastes review comments from CodeRabbit, Claude, Cursor, or similar tools.
---

# PR Review Coordinator

Parses PR review feedback and dispatches issues to `pr-issue-fixer` subagents for resolution.

## Workflow

### Step 1: Parse Issues

Extract issues from the review. Look for:

| Source | Patterns to Find |
|--------|------------------|
| CodeRabbit | "Actionable comments", severity badges, file paths with line numbers |
| Claude bot | Priority sections (Critical/High/Medium/Low), code suggestions |
| Cursor bot | Numbered suggestions with code snippets |
| Manual | Bulleted/numbered issues with descriptions |

For each issue, extract:

```
- File: (required) path/to/file.ts
- Lines: (optional) 45-50 or 123
- Priority: Critical > High > Medium > Low
- Category: cache-management | error-handling | performance | code-style | testing | documentation | security | architecture
- Problem: What's wrong
- Suggestion: The fix (preserve code snippets!)
```

### Step 2: Group and Prioritize

1. Sort by priority (Critical first)
2. Group by file (same-file issues run sequentially)
3. Flag conflicts (multiple issues on same lines)

### Step 3: Dispatch to Fixers

Use the Task tool with `subagent_type="pr-issue-fixer"`:

```
Use Task tool:
- subagent_type: "pr-issue-fixer"
- prompt: |
    Fix this PR review issue:
    - File: [path]
    - Lines: [numbers]
    - Priority: [level]
    - Category: [category]
    - Problem: [description]
    - Suggestion: [fix with code snippets]
    - Context: [relevant architecture info]
    
    After fixing, run verification and report status.
```

**Parallelization:**
- PARALLEL: Issues in different files
- SEQUENTIAL: Issues in the same file

### Step 4: Compile Results

After all fixers complete:

```markdown
## PR Review Resolution Summary

### Processed: X issues

| Status | File | Issue |
|--------|------|-------|
| ✅ | path/file.ts | Brief description |
| ⚠️ | path/other.ts | Partial - [what remains] |
| ❌ | path/broken.ts | [reason] |

### Verification
- Typecheck: ✅/❌
- Tests: N passed, M failed

### Follow-up
- [ ] Items needing human review
```

### Step 5: Final Verification

Run after all issues addressed:

```bash
pnpm nx typecheck <project>
pnpm nx test <project> --watch=false
```

## Example

**Input:**
```
CodeRabbit review:
1. [High] apps/ui/utils/cache.ts:45 - Cache unbounded, add LRU
2. [Medium] apps/ui/worker.ts:123 - Memory leak in cleanup
```

**Actions:**
1. Parse → 2 issues, 2 different files
2. Dispatch in parallel (different files)
3. Collect results
4. Run final verification
5. Report summary

## Guidelines

- Preserve code snippets from suggestions
- Skip "nitpick" or "optional" issues unless requested
- For vague issues, include surrounding review context
- Flag conflicting suggestions for human decision
