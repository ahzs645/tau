import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '../..');
const quickstartPath = resolve(root, 'apps/ui/content/docs/(runtime)/getting-started/quick-start.mdx');

const maxLines = 15;
const maxImports = 3;

const extractFirstTypescriptBlock = (mdx: string): { content: string; lineNumber: number } | undefined => {
  const lines = mdx.split('\n');
  const startIndex = lines.findIndex((line) => /^```typescript(\s|$)/.test(line));
  if (startIndex === -1) {
    return undefined;
  }

  const bodyStart = startIndex + 1;
  const endOffset = lines.slice(bodyStart).findIndex((line) => line.trim() === '```');
  if (endOffset === -1) {
    return undefined;
  }

  return {
    content: lines.slice(bodyStart, bodyStart + endOffset).join('\n'),
    lineNumber: bodyStart + 1,
  };
};

const trimTrailingBlankLines = (content: string): string[] => {
  const lines = content.split('\n');
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') {
    lines.pop();
  }
  return lines;
};

const countImportLines = (lines: string[]): number => lines.filter((line) => /^\s*import\s/.test(line)).length;

const raw = readFileSync(quickstartPath, 'utf8');
const block = extractFirstTypescriptBlock(raw);

if (!block) {
  console.error(`\u001B[31mERROR\u001B[0m  No \`\`\`typescript fenced block found in ${quickstartPath}`);
  process.exit(1);
}

const lines = trimTrailingBlankLines(block.content);
const importCount = countImportLines(lines);

const errors: string[] = [];

if (lines.length > maxLines) {
  errors.push(
    `Quickstart primary snippet is ${lines.length} lines, budget is ${maxLines}. ` +
      `First block starts at line ${block.lineNumber}. Tighten the snippet or move advanced patterns to a dedicated guide.`,
  );
}

if (importCount > maxImports) {
  errors.push(
    `Quickstart primary snippet has ${importCount} import lines, budget is ${maxImports}. ` +
      `Reduce imports to keep the quickstart copy-pasteable.`,
  );
}

if (errors.length > 0) {
  console.log(`\n${quickstartPath.replace(root + '/', '')}`);
  for (const message of errors) {
    console.log(`  \u001B[31mERROR\u001B[0m  ${message}`);
  }
  process.exit(1);
}

console.log(
  `quick-start.mdx primary snippet OK: ${lines.length} lines (budget ${maxLines}), ${importCount} imports (budget ${maxImports})`,
);
