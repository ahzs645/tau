import process from 'node:process';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

// ── Types ───────────────────────────────────────────────────────

export type RepoConfig = {
  upstream: string;
  fork?: string;
  branch?: string;
  path?: string;
  description?: string;
  shallow?: boolean;
};

export type GroupConfig = {
  description?: string;
  repos: string[];
};

export type Manifest = {
  version: number;
  repos_dir: string;
  owner: string;
  groups: Record<string, GroupConfig>;
  repos: Record<string, RepoConfig>;
};

export type RepoStatus = {
  name: string;
  cloned: boolean;
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  upstreamAhead?: number;
  lastActivity?: number;
};

export type RepoContext = {
  name: string;
  repo: RepoConfig;
  manifest: Manifest;
  root: string;
};

// ── Root Detection ──────────────────────────────────────────────

export function findRoot(): string {
  if (process.env['TAU_ROOT']) {
    const envRoot = process.env['TAU_ROOT'];
    if (existsSync(join(envRoot, 'repos.yaml'))) {
      return envRoot;
    }
  }

  let directory = process.cwd();
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'repos.yaml'))) {
      return directory;
    }

    directory = dirname(directory);
  }

  throw new Error('Could not find repos.yaml. Run from the workspace root or set TAU_ROOT.');
}

// ── Manifest Read/Write ─────────────────────────────────────────

export function readManifest(root?: string): {
  manifest: Manifest;
  root: string;
} {
  const resolvedRoot = root ?? findRoot();
  const filePath = join(resolvedRoot, 'repos.yaml');
  const content = readFileSync(filePath, 'utf8');
  const manifest = yamlLoad(content) as Manifest;
  return { manifest, root: resolvedRoot };
}

export function writeManifest(manifest: Manifest, root?: string): void {
  const resolvedRoot = root ?? findRoot();
  const filePath = join(resolvedRoot, 'repos.yaml');
  const content = yamlDump(manifest, {
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
  });
  writeFileSync(filePath, content, 'utf8');
}

// ── URL Helpers ─────────────────────────────────────────────────

export function repoUrl(ownerRepo: string): string {
  return `https://github.com/${ownerRepo}.git`;
}

export function parseOwnerRepo(url: string): string | undefined {
  const match = /github\.com[/:](?<ownerRepo>[^/]+\/[^./]+?)(?:\.git)?$/.exec(url);
  return match?.groups?.['ownerRepo'];
}

// ── Path Helpers ────────────────────────────────────────────────

export function repoPath(context: RepoContext): string {
  const { name, repo, manifest, root } = context;
  const relative = repo.path ?? name;
  return resolve(root, manifest.repos_dir, relative);
}

// ── Repo Resolution ─────────────────────────────────────────────

export function resolveRepos(
  manifest: Manifest,
  filter?: {
    name?: string;
    group?: string;
    all?: boolean;
  },
): Array<[string, RepoConfig]> {
  if (!filter || filter.all) {
    return Object.entries(manifest.repos);
  }

  if (filter.name) {
    const repo = manifest.repos[filter.name];
    if (!repo) {
      throw new Error(`Repo "${filter.name}" not found in manifest.`);
    }

    return [[filter.name, repo]];
  }

  if (filter.group) {
    const group = manifest.groups[filter.group];
    if (!group) {
      throw new Error(`Group "${filter.group}" not found. Available: ${Object.keys(manifest.groups).join(', ')}`);
    }

    return group.repos
      .map((name): [string, RepoConfig] | undefined => {
        const repo = manifest.repos[name];
        if (!repo) {
          console.warn(`Warning: repo "${name}" in group "${filter.group}" not found in manifest.`);
          return undefined;
        }

        return [name, repo];
      })
      .filter((entry): entry is [string, RepoConfig] => entry !== undefined);
  }

  return Object.entries(manifest.repos);
}

// ── Git Helpers ─────────────────────────────────────────────────

export function isCloned(context: RepoContext): boolean {
  const directory = repoPath(context);
  return existsSync(join(directory, '.git'));
}

export function gitExec(context: RepoContext, args: string[]): string {
  const directory = repoPath(context);
  return execSync(['git', ...args].join(' '), {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function getRepoStatus(context: RepoContext): RepoStatus {
  const { name, repo } = context;
  if (!isCloned(context)) {
    return { name, cloned: false };
  }

  try {
    const branch = gitExec(context, ['rev-parse', '--abbrev-ref', 'HEAD']);

    const statusOutput = gitExec(context, ['status', '--porcelain']);
    const dirty = statusOutput.length > 0;

    let ahead = 0;
    let behind = 0;
    try {
      const abOutput = gitExec(context, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
      const parts = abOutput.split('\t');
      behind = Number.parseInt(parts[0] ?? '0', 10);
      ahead = Number.parseInt(parts[1] ?? '0', 10);
    } catch {
      // No tracking branch
    }

    let upstreamAhead: number | undefined;
    if (repo.fork) {
      try {
        const defaultBranch = repo.branch ?? branch;
        const uaOutput = gitExec(context, ['rev-list', '--count', `HEAD..upstream/${defaultBranch}`]);
        upstreamAhead = Number.parseInt(uaOutput, 10);
      } catch {
        // Upstream not fetched yet
      }
    }

    const lastActivity = getLastActivity(context);

    return {
      name,
      cloned: true,
      branch,
      dirty,
      ahead,
      behind,
      upstreamAhead,
      lastActivity,
    };
  } catch {
    return { name, cloned: true };
  }
}

export function getLastActivity(context: RepoContext): number | undefined {
  if (!isCloned(context)) {
    return undefined;
  }

  try {
    const ts = gitExec(context, ['log', '-1', '--format=%ct']);
    return Number.parseInt(ts, 10);
  } catch {
    return undefined;
  }
}

// ── GitHub Metadata ─────────────────────────────────────────────

export function fetchRepoDescription(upstream: string): string | undefined {
  try {
    const raw = execSync(`gh repo view ${upstream} --json description -q .description`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

// ── Clone ───────────────────────────────────────────────────────

export function cloneRepo(context: RepoContext): { action: 'cloned' | 'skipped'; message: string } {
  const { name, repo, manifest, root } = context;
  const directory = repoPath(context);
  if (existsSync(join(directory, '.git'))) {
    return { action: 'skipped', message: `${name}: already cloned` };
  }

  if (!repo.description) {
    const description = fetchRepoDescription(repo.upstream);
    if (description) {
      repo.description = description;
      writeManifest(manifest, root);
    }
  }

  const cloneUrl = repo.fork ? repoUrl(repo.fork) : repoUrl(repo.upstream);
  const args = ['git', 'clone', cloneUrl, directory];
  if (repo.shallow) {
    args.splice(1, 0, '--depth', '1');
  }

  if (repo.branch) {
    args.splice(1, 0, '--branch', repo.branch);
  }

  execSync(args.join(' '), { stdio: 'inherit' });

  if (repo.fork) {
    execSync(`git -C ${directory} remote add upstream ${repoUrl(repo.upstream)}`, {
      stdio: 'inherit',
    });
  }

  return { action: 'cloned', message: `${name}: cloned` };
}

// ── Sync ────────────────────────────────────────────────────────

export function syncRepo(context: RepoContext): { ok: boolean; message: string } {
  const { name } = context;
  if (!isCloned(context)) {
    return { ok: false, message: `${name}: not cloned` };
  }

  try {
    gitExec(context, ['fetch', '--all', '--prune']);
    try {
      gitExec(context, ['pull', '--ff-only']);
    } catch {
      return {
        ok: false,
        message: `${name}: fetch ok, pull --ff-only failed (diverged?)`,
      };
    }

    return { ok: true, message: `${name}: synced` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${name}: ${message}` };
  }
}

// ── Fork / Unfork ───────────────────────────────────────────────

export function forkRepo(name: string, manifest: Manifest, root: string): { ok: boolean; message: string } {
  const repo = manifest.repos[name];
  if (!repo) {
    return { ok: false, message: `Repo "${name}" not found in manifest.` };
  }

  if (repo.fork) {
    return {
      ok: false,
      message: `${name}: already forked to ${repo.fork}`,
    };
  }

  const upstreamParts = repo.upstream.split('/');
  const repoName = upstreamParts[1];
  const forkSlug = `${manifest.owner}/${repoName}`;

  try {
    execSync(`gh repo fork ${repo.upstream} --org ${manifest.owner} --clone=false`, { stdio: 'inherit' });
  } catch {
    // Fork may already exist on GitHub
  }

  repo.fork = forkSlug;
  writeManifest(manifest, root);

  const context = { name, repo, manifest, root };
  if (isCloned(context)) {
    const directory = repoPath(context);
    try {
      execSync(`git -C ${directory} remote rename origin upstream`, {
        stdio: 'pipe',
      });
    } catch {
      // Upstream remote may already exist
    }

    try {
      execSync(`git -C ${directory} remote add origin ${repoUrl(forkSlug)}`, {
        stdio: 'pipe',
      });
    } catch {
      execSync(`git -C ${directory} remote set-url origin ${repoUrl(forkSlug)}`, {
        stdio: 'pipe',
      });
    }
  }

  return { ok: true, message: `${name}: forked to ${forkSlug}` };
}

export function unforkRepo(name: string, manifest: Manifest, root: string): { ok: boolean; message: string } {
  const repo = manifest.repos[name];
  if (!repo) {
    return { ok: false, message: `Repo "${name}" not found in manifest.` };
  }

  if (!repo.fork) {
    return { ok: false, message: `${name}: not forked` };
  }

  const context = { name, repo, manifest, root };
  if (isCloned(context)) {
    const directory = repoPath(context);
    try {
      execSync(`git -C ${directory} remote remove origin`, { stdio: 'pipe' });
      execSync(`git -C ${directory} remote rename upstream origin`, {
        stdio: 'pipe',
      });
    } catch {
      // Best effort
    }
  }

  delete repo.fork;
  writeManifest(manifest, root);

  return { ok: true, message: `${name}: unforked (upstream only)` };
}
