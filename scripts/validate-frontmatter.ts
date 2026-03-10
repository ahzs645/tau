import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import matter from 'gray-matter';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '..');
const policyDirectory = join(root, 'docs/policy');
const researchDirectory = join(root, 'docs/research');
const stalenessDays = 180;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO 8601 date (YYYY-MM-DD)');

const policySchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).max(300),
  status: z.enum(['draft', 'active', 'deprecated', 'superseded']),
  created: isoDate,
  updated: isoDate,
  related: z.array(z.string()).optional(),
  superseded_by: z.string().optional(), // eslint-disable-line @typescript-eslint/naming-convention -- YAML field
});

const researchSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).max(300),
  status: z.enum(['draft', 'active', 'superseded']),
  created: isoDate,
  updated: isoDate,
  category: z.enum(['audit', 'investigation', 'comparison', 'architecture', 'migration', 'optimization', 'reference']),
  related: z.array(z.string()).optional(),
  superseded_by: z.string().optional(), // eslint-disable-line @typescript-eslint/naming-convention -- YAML field
});

type Diagnostic = { level: 'ERROR' | 'WARN'; message: string };
type FileResult = { path: string; diagnostics: Diagnostic[] };

const listMarkdown = (directory: string): string[] =>
  readdirSync(directory)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(directory, f));

const extractH1 = (content: string): string | undefined => {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
};

const daysBetween = (a: string, b: Date): number => {
  const dateA = new Date(a);
  return Math.floor((b.getTime() - dateA.getTime()) / (1000 * 60 * 60 * 24));
};

type Frontmatter = {
  title?: string;
  related?: string[];
  superseded_by?: string;
  updated?: string;
};

const validateFile = (filePath: string, schema: z.ZodObject<z.ZodRawShape>): FileResult => {
  const diagnostics: Diagnostic[] = [];
  const relativePath = filePath.replace(root + '/', '');
  const raw = readFileSync(filePath, 'utf8');

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch {
    diagnostics.push({ level: 'ERROR', message: 'Failed to parse frontmatter' });
    return { path: relativePath, diagnostics };
  }

  if (Object.keys(parsed.data as Record<string, unknown>).length === 0) {
    diagnostics.push({ level: 'ERROR', message: 'Missing frontmatter entirely' });
    return { path: relativePath, diagnostics };
  }

  const result = schema.safeParse(parsed.data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.join('.');
      diagnostics.push({
        level: 'ERROR',
        message: field ? `${field}: ${issue.message}` : issue.message,
      });
    }
  }

  if (result.success) {
    const { data } = result as { data: Frontmatter };

    if (Array.isArray(data.related)) {
      for (const reference of data.related) {
        const absReference = resolve(root, reference);
        if (!existsSync(absReference)) {
          diagnostics.push({
            level: 'ERROR',
            message: `related: "${reference}" does not exist`,
          });
        }
      }
    }

    if (data.superseded_by) {
      const absReference = resolve(root, data.superseded_by);
      if (!existsSync(absReference)) {
        diagnostics.push({
          level: 'ERROR',
          message: `superseded_by: "${data.superseded_by}" does not exist`,
        });
      }
    }

    const h1 = extractH1(parsed.content);
    if (h1 && data.title && h1 !== data.title) {
      diagnostics.push({
        level: 'WARN',
        message: `title "${data.title}" ≠ H1 "${h1}"`,
      });
    }

    if (data.updated) {
      const age = daysBetween(data.updated, new Date());
      if (age > stalenessDays) {
        diagnostics.push({
          level: 'WARN',
          message: `updated ${age} days ago (>${stalenessDays} day threshold)`,
        });
      }
    }
  }

  return { path: relativePath, diagnostics };
};

const policies = listMarkdown(policyDirectory);
const research = listMarkdown(researchDirectory);

const results: FileResult[] = [
  ...policies.map((f) => validateFile(f, policySchema)),
  ...research.map((f) => validateFile(f, researchSchema)),
];

let errors = 0;
let warnings = 0;

for (const { path, diagnostics } of results) {
  if (diagnostics.length === 0) {
    continue;
  }

  console.log(`\n${path}`);
  for (const d of diagnostics) {
    const prefix = d.level === 'ERROR' ? '  \u001B[31mERROR\u001B[0m' : '  \u001B[33mWARN\u001B[0m ';
    console.log(`${prefix}  ${d.message}`);
    if (d.level === 'ERROR') {
      errors++;
    } else {
      warnings++;
    }
  }
}

const totalFiles = policies.length + research.length;
console.log(
  `\nSummary: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} across ${totalFiles} files`,
);

if (errors > 0) {
  process.exit(1);
}
