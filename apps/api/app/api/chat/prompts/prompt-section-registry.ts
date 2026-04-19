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
 * Creates a section registry that partitions prompt sections into static
 * (globally cacheable) and dynamic (per-request) buckets.
 */
export type SectionRegistry = {
  register: (section: PromptSection) => void;
  resolve: () => { static: string; dynamic: string };
  invalidate: (name: string) => void;
};

export function createSectionRegistry(): SectionRegistry {
  const sections: CachedSection[] = [];

  return {
    register(section: PromptSection): void {
      sections.push({ ...section });
    },

    resolve(): { static: string; dynamic: string } {
      const staticParts: string[] = [];
      const dynamicParts: string[] = [];

      for (const section of sections) {
        section.cachedValue ??= section.compute();

        if (!section.cachedValue) {
          continue;
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
