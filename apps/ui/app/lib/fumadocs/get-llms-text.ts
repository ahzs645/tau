import type { InferPageType } from 'fumadocs-core/source';
import { source } from '#lib/fumadocs/source.js';

export async function getLlmText(page: InferPageType<typeof source>): Promise<string> {
  const processed = await page.data.getText('processed');

  return `# ${page.data.title}
URL: ${page.url}

${processed}`;
}

type Section = {
  title: string;
  pages: Array<InferPageType<typeof source>>;
};

const formatSectionTitle = (slug: string): string => {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Generates a comprehensive reference document in the Stripe llms.txt style
 * This provides an overview of all documentation pages with links and descriptions
 */
export async function getLlmRefText({
  siteTitle,
  siteUrl,
  pathPrefix,
}: {
  siteTitle: string;
  siteUrl: string;
  /** When set, only pages under this prefix are included; sections follow the next path segment (e.g. getting-started, guides). */
  pathPrefix?: string;
}): Promise<string> {
  const normalizedPrefix = pathPrefix && pathPrefix.length > 0 ? pathPrefix.replace(/\/$/, '') : undefined;

  let pages = source.getPages();
  if (normalizedPrefix) {
    pages = pages.filter((page) => page.url === normalizedPrefix || page.url.startsWith(`${normalizedPrefix}/`));
  }

  const sections = new Map<string, Section>();

  for (const page of pages) {
    let sectionKey: string;
    let sectionTitle: string;

    if (normalizedPrefix) {
      const remainder = page.url === normalizedPrefix ? '' : page.url.slice(normalizedPrefix.length).replace(/^\//, '');
      const firstSegment = remainder.split('/').find((part) => part.length > 0);

      if (firstSegment) {
        sectionKey = firstSegment;
        sectionTitle = formatSectionTitle(firstSegment);
      } else {
        sectionKey = 'overview';
        sectionTitle = 'Overview';
      }
    } else {
      const pathParts = page.url.split('/').filter((part) => part.length > 0);

      sectionKey = 'docs';
      sectionTitle = 'Documentation';

      if (pathParts.length > 1 && pathParts[1]) {
        sectionKey = pathParts[1];
        sectionTitle = formatSectionTitle(sectionKey);
      }
    }

    if (!sections.has(sectionKey)) {
      sections.set(sectionKey, {
        title: sectionTitle,
        pages: [],
      });
    }

    const section = sections.get(sectionKey);
    if (section) {
      section.pages.push(page);
    }
  }

  const output: string[] = [];

  output.push(`# ${siteTitle}`);

  for (const section of sections.values()) {
    if (section.pages.length === 0) {
      continue;
    }

    output.push('', `## ${section.title}`);

    for (const page of section.pages) {
      const { title } = page.data;
      const url = `${siteUrl}${page.url}`;
      const description = page.data.description ?? '';

      if (description) {
        output.push(`- [${title}](${url}): ${description}`);
      } else {
        output.push(`- [${title}](${url})`);
      }
    }
  }

  return output.join('\n');
}
