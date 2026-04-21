/**
 * A prompt section in the registry. Sections with `cacheBreak: false` are
 * collected into the static (globally cacheable) prompt; those with
 * `cacheBreak: true` go into the dynamic (per-request) prompt.
 *
 * The static/dynamic partitioning lets the model provider keep a long-lived
 * cache hit on the stable portion of the system prompt while the per-request
 * tail (timestamps, environment, git status, etc.) is composed fresh.
 */
export type PromptSection = {
  name: string;
  compute: () => string;
  cacheBreak: boolean;
};

type CachedSection = PromptSection & { cachedValue?: string };

/**
 * Per-section telemetry observation emitted by `resolve({ onSectionResolved })`
 * (R23). Wired by `chat.service.ts` to the `gen_ai.prompt.section.size`
 * histogram so we can see byte budgets per section and which sections break
 * the cache.
 */
export type ResolvedSection = {
  name: string;
  cacheBreak: boolean;
  byteSize: number;
};

export type ResolveOptions = {
  /**
   * Invoked once per non-empty section, in registration order, with the
   * section name, its cache class, and the UTF-8 byte length of its resolved
   * body. Empty sections are skipped — they don't contribute bytes to the
   * assembled prompt and would only add noise to the histogram.
   */
  onSectionResolved?: (resolved: ResolvedSection) => void;
};

/**
 * Creates a section registry that partitions prompt sections into static
 * (globally cacheable) and dynamic (per-request) buckets.
 */
export type SectionRegistry = {
  register: (section: PromptSection) => void;
  resolve: (options?: ResolveOptions) => { static: string; dynamic: string };
  invalidate: (name: string) => void;
};

export function createSectionRegistry(): SectionRegistry {
  const sections: CachedSection[] = [];

  return {
    register(section: PromptSection): void {
      sections.push({ ...section });
    },

    resolve(options?: ResolveOptions): { static: string; dynamic: string } {
      const staticParts: string[] = [];
      const dynamicParts: string[] = [];

      for (const section of sections) {
        section.cachedValue ??= section.compute();

        if (!section.cachedValue) {
          continue;
        }

        if (options?.onSectionResolved) {
          options.onSectionResolved({
            name: section.name,
            cacheBreak: section.cacheBreak,
            byteSize: Buffer.byteLength(section.cachedValue, 'utf8'),
          });
        }

        if (section.cacheBreak) {
          dynamicParts.push(section.cachedValue);
        } else {
          staticParts.push(section.cachedValue);
        }
      }

      return {
        static: staticParts.join('\n\n'),
        dynamic: dynamicParts.join('\n\n'),
      };
    },

    invalidate(name: string): void {
      for (const section of sections) {
        if (section.name === name) {
          section.cachedValue = undefined;
        }
      }
    },
  };
}
