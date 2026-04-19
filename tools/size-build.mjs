/**
 * Discovers all projects with .size-limit.json, builds them via Nx,
 * and writes a merged config to the workspace root for size-limit to consume.
 *
 * Used by size-limit-action in CI to produce a single consolidated PR comment
 * across all packages with size budgets.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

function getProjectRoots() {
  const output = execSync('pnpm nx show projects --json', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const projects = JSON.parse(output.trim().split('\n').pop());
  const results = [];

  for (const project of projects) {
    try {
      const info = execSync(`pnpm nx show project ${project} --json`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const { root } = JSON.parse(info);
      const configPath = join(root, '.size-limit.json');
      if (existsSync(configPath)) {
        results.push({ project, root, configPath });
      }
    } catch {
      // Project might not be queryable, skip
    }
  }

  return results;
}

function prefixPath(root, p) {
  if (p.startsWith('!')) {
    return `!${root}/${p.slice(1)}`;
  }
  return `${root}/${p}`;
}

const projects = getProjectRoots();

if (projects.length === 0) {
  console.log('No projects with .size-limit.json found');
  writeFileSync('.size-limit.json', '[]');
  process.exit(0);
}

const merged = [];

for (const { project, root, configPath } of projects) {
  console.log(`Building ${project}...`);
  try {
    execSync(`pnpm nx build ${project}`, { stdio: 'inherit' });
  } catch {
    console.warn(`Warning: Failed to build ${project}, skipping`);
    continue;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  for (const entry of config) {
    const prefixed = {
      ...entry,
      name: `${project}: ${entry.name}`,
    };

    if (Array.isArray(entry.path)) {
      prefixed.path = entry.path.map((p) => prefixPath(root, p));
    } else {
      prefixed.path = prefixPath(root, entry.path);
    }

    merged.push(prefixed);
  }
}

writeFileSync('.size-limit.json', JSON.stringify(merged, null, 2));
console.log(`Merged ${merged.length} size-limit entries from ${projects.length} project(s)`);
