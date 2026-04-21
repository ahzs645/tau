/**
 * Single-source-of-truth copy for the `test_requirements` example block and
 * the `Available checks` blurb the agent sees. Rendered identically in:
 *  - the cad-agent system prompt (`apps/api/.../cad-agent.prompt.ts`)
 *  - the `edit_tests` tool description (`apps/api/.../tool-edit-tests.ts`)
 *
 * Per `docs/research/mesh-continuity-test-semantics.md` R4 + R5 the LLM should
 * never see two slightly-different phrasings of the same check vocabulary.
 *
 * @module
 */

/* eslint-disable @typescript-eslint/naming-convention -- file-path keys (e.g. 'main.ts') aren't camelCase */

/**
 * Canonical `test.json` example, keyed by the `<file>` placeholder. Renderers
 * substitute the placeholder with the kernel-appropriate file extension.
 *
 * Includes one example each of the surviving 3-check vocabulary
 * (boundingBox, connectedComponents, watertight). Mirrors research §Code
 * Examples R4 lines 479-491.
 *
 * @public
 */
export const CANONICAL_TEST_REQUIREMENTS_EXAMPLE = {
  '<file>': {
    requirements: [
      {
        id: 'req_width',
        type: 'measurement',
        description: 'Box is 100mm wide',
        check: 'boundingBox',
        expected: { size: { x: 100 } },
        tolerance: 1,
      },
      {
        id: 'req_height',
        type: 'measurement',
        description: 'Box is 25mm tall',
        check: 'boundingBox',
        expected: { size: { z: 25 } },
        tolerance: 1,
      },
      {
        id: 'req_centered',
        type: 'measurement',
        description: 'Centered at origin XY',
        check: 'boundingBox',
        expected: { center: { x: 0, y: 0 } },
        tolerance: 0.5,
      },
      {
        id: 'req_one_piece',
        type: 'measurement',
        description: 'Assembly groups into 1',
        check: 'connectedComponents',
        expected: { count: 1 },
      },
      {
        id: 'req_watertight',
        type: 'measurement',
        description: 'Mesh is watertight',
        check: 'watertight',
      },
    ],
  },
} as const;

/**
 * Renders {@link CANONICAL_TEST_REQUIREMENTS_EXAMPLE} as a fenced JSON code
 * block with `<file>` substituted for the kernel-appropriate `main.<ext>`.
 *
 * @param fileExtension - Kernel-specific file extension (e.g. `'ts'`,
 *   `'scad'`, `'js'`). A leading dot is stripped defensively.
 * @returns A markdown code block ready to interpolate into a system prompt
 * @public
 */
export const renderCanonicalExample = (fileExtension: string): string => {
  const extension = fileExtension.startsWith('.') ? fileExtension.slice(1) : fileExtension;
  const concrete = { [`main.${extension}`]: CANONICAL_TEST_REQUIREMENTS_EXAMPLE['<file>'] };
  return ['```json', JSON.stringify(concrete, null, 2), '```'].join('\n');
};

/**
 * Single-sourced "Available checks" blurb. Rendered identically by the system
 * prompt body and the `edit_tests` tool description so the LLM never sees a
 * diverging vocabulary. Mirrors research §Code Examples R5 lines 497-516.
 *
 * @public
 */
export const AVAILABLE_CHECKS_COPY = `Available checks (each answers exactly one question — no overlap):
- boundingBox          — "Is the model the right SIZE / POSITION?" Per-axis opt-in for
                         size and center; \`tolerance\` is per-axis tolerance in mm.
- connectedComponents  — "How many SPATIALLY-DISJOINT CHUNKS does the geometry contain?"
                         Pure-geometry AABB clustering. \`tolerance\` (mm, default 0.1) is
                         the maximum gap between two parts' bounding boxes that still
                         counts as "connected." Use \`expected.count: 1\` for "the assembly
                         is one cohesive thing"; raise tolerance if parts visibly touch
                         but the test still reports >1.
- watertight           — "Is each geometry unit's surface CLOSED (manifold / 3D-printable)?"
                         The canonical "did the boolean fuse succeed" guardrail. Assert
                         per geometry unit (e.g. \`lib/<part>.ts\`) so each part is verified
                         independently of how they are returned from \`main()\`.

For "is this one fused solid?" assert \`watertight\` on a geometry unit that exports a
single solid — a fused solid is closed-manifold iff the boolean fuse succeeded. Do NOT
use \`connectedComponents\` for that intent (it answers "how many spatial chunks," not
"is the boolean fuse welded").`;
