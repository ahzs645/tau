---
name: create-policy
description: Create or update policy documents in docs/policy/. Use when writing a new policy, updating an existing policy, reviewing policy structure, or when the user mentions policy docs, coding standards, or architectural decisions that should be documented as policy.
---

# Create Policy

Guide for authoring policy documents in `docs/policy/`. Policies are internal reference docs that codify decisions, conventions, and rules for the codebase. They are consumed by both humans and AI agents (via `.cursor/rules/*.mdc` summaries).

## Structure Template

Every policy follows this skeleton. Include sections in order; omit optional sections when not applicable.

```markdown
---
title: '{Title} Policy'
description: '{One-line description for agent discoverability}'
status: active
created: YYYY-MM-DD
updated: YYYY-MM-DD
related: # optional
  - docs/research/related-research.md
---

# {Title} Policy

{One-line scope statement: "Internal reference for [what this covers]."}

## Rationale

Why this policy exists. Link the problem to the rules. 2-4 sentences max.

## Rules

### 1. Rule Name

Rule statement. Use imperative voice: "Do X", "Never Y".

**Why**: One sentence explaining the rationale (inline with the rule).

CORRECT:
\`\`\`typescript
// example of correct usage
\`\`\`

INCORRECT:
\`\`\`typescript
// example of what to avoid
\`\`\`

### 2. Next Rule

...

## Anti-Patterns <!-- optional -->

Explicit "do not" rules when the wrong approach is common or tempting.

## Summary Checklist <!-- optional -->

- [ ] Actionable checklist for compliance

## References <!-- optional -->

- [External spec](url)
- Related: `docs/policy/other-policy.md`
```

## Section Guide

| Section               | When to include                                    | Purpose                             |
| --------------------- | -------------------------------------------------- | ----------------------------------- |
| **Rationale**         | Always                                             | Connects the problem to the rules   |
| **Rules** (numbered)  | Always                                             | Concrete "must"/"never" statements  |
| **Decision tables**   | When classifying options, mappings, or error codes | Quick reference lookup              |
| **Code examples**     | When rules govern code patterns                    | Show CORRECT/INCORRECT side by side |
| **Anti-patterns**     | When the wrong approach is common                  | Explicit "do not" guidance          |
| **Diagrams**          | When architecture or data flow matters             | ASCII or Mermaid                    |
| **Summary Checklist** | When the policy is implementation-focused          | Review gate before merging          |
| **Known Limitations** | When constraints exist                             | Prevent workaround attempts         |
| **References**        | When external specs or related policies exist      | Cross-link                          |

## Writing Rules

### Voice

- **Imperative/prescriptive** for implementation policies: "Use X", "Never Y", "Must Z"
- **Descriptive** only in Rationale sections to explain "why"
- Strategic policies (e.g. vision) may use aspirational voice

### Example Labels

Use `CORRECT:` and `INCORRECT:` consistently. Do not use Good/Bad, WRONG/RIGHT, or other variants.

### Numbering

Number rules as H3 headings (`### 1. Rule Name`) when the policy has 3+ distinct rules. This makes individual rules referenceable.

### Inline Rationale

Attach `**Why**:` to rules that aren't self-explanatory. Keep to one sentence.

```markdown
### 3. Clone ArrayBuffers Before Transfer

Clone `Uint8Array` content before `postMessage` with transferables.

**Why**: Transfer detaches the original buffer; concurrent consumers get zero-length views.
```

### Tables Over Prose

Prefer decision tables for classification, lifecycle phases, error codes, or option comparisons. Tables are scannable; paragraphs are not.

### Cross-References

Link to related policies and research docs. Use relative paths:

```markdown
- Related: `docs/policy/testing-policy.md`
- Research: `docs/research/filesystem-architecture.md`
```

## Size Budget

- **Target**: 150-400 lines
- **Max**: 500 lines — split into multiple policies if larger
- **Min**: 50 lines — if shorter, consider adding to an existing policy

## Discoverability

Policies are discoverable through a tiered system (see `docs/policy/agents-md-policy.md`). Use the cheapest tier that provides adequate discoverability:

1. **Most policies** need no companion rule. `AGENTS.md` points to `docs/policy/` and the agent can search/read on demand.
2. **Create a glob-scoped `.cursor/rules/*.mdc`** only when the policy governs code patterns during active editing (e.g., `*.test.ts` → testing, `*.tsx` → React patterns). Keep the rule under 50 lines — it references the policy, it does not duplicate it.
3. **Never create an `alwaysApply` rule** for a policy.

```markdown
---
description: Brief description
globs: relevant/file/patterns/**/*.ts
alwaysApply: false
---

# Rule Title

Follow `docs/policy/{name}-policy.md` for the full policy. Key rules:

- Rule 1 summary
- Rule 2 summary
```

## Checklist

Before finalizing a policy:

- [ ] Filename matches `docs/policy/{name}-policy.md`
- [ ] YAML frontmatter with title, description, status, created, updated
- [ ] Frontmatter `title` matches H1 heading
- [ ] Frontmatter `related` lists cross-referenced docs
- [ ] Opens with one-line scope statement
- [ ] Has Rationale section
- [ ] Rules are numbered and use imperative voice
- [ ] Examples use CORRECT/INCORRECT labels
- [ ] Tables used for classification (not prose)
- [ ] Under 500 lines
- [ ] Passes `pnpm docs:validate`
- [ ] Companion `.cursor/rules/*.mdc` only if policy governs active editing patterns
