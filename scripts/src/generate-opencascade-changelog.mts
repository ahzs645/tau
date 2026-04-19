/* oxlint-disable unicorn/no-array-push-push -- easier to read */
/**
 * Generates a changelog for OpenCASCADE Technology from V7_6_2 to V8_0_0_rc4.
 *
 * Fetches release notes from GitHub for each tag, gathers commit counts
 * between consecutive tags from the local OCCT repo, and outputs structured
 * markdown to docs/opencascade-v7.8-v8rc4-changelog.md.
 *
 * Prerequisites:
 *   - repos/OCCT must exist with all tags fetched
 *   - `gh` CLI must be authenticated
 *
 * Usage: node --import tsx scripts/src/generate-opencascade-changelog.mts
 */

import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDirectory = join(__dirname, '../..');
const occtDirectory = join(rootDirectory, 'repos', 'OCCT');
const outputFile = join(rootDirectory, 'docs', 'opencascade-v7.62-v8rc4-changelog.md');

const repo = 'Open-Cascade-SAS/OCCT';
const baseTag = 'V7_6_2';

const allTags = [
  'V7_6_3',
  'V7_7_0',
  'V7_7_1',
  'V7_7_2',
  'V7_8_0',
  'V7_8_1',
  'V7_9_0',
  'V7_9_1',
  'V7_9_2',
  'V7_9_3',
  'V8_0_0_rc1',
  'V8_0_0_rc2',
  'V8_0_0_rc3',
  'V8_0_0_rc4',
] as const;

type TagInfo = {
  tag: string;
  date: string;
  commitCount: number;
  body: string;
};

function run(command: string, cwd?: string): string {
  return execSync(command, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function formatTag(tag: string): string {
  return tag.replaceAll('_', '.');
}

function getTagDate(tag: string): string {
  return run(`git log -1 --format='%ci' ${tag}`, occtDirectory).split(' ')[0] ?? '';
}

function getCommitCount(from: string, to: string): number {
  return Number.parseInt(run(`git rev-list --count ${from}..${to}`, occtDirectory), 10);
}

function fetchReleaseBody(tag: string): string {
  try {
    return run(`gh api "repos/${repo}/releases/tags/${tag}" --jq '.body'`);
  } catch {
    console.warn(`Warning: Could not fetch release notes for ${tag}`);
    return '*No release notes available.*';
  }
}

function classifyBreakingChange(body: string): string[] {
  const markers: string[] = [];
  const lower = body.toLowerCase();

  if (lower.includes('c++17')) {
    markers.push('C++17');
  }

  if (lower.includes('removed') || lower.includes('removal')) {
    markers.push('API Removal');
  }

  if (lower.includes('deprecated')) {
    markers.push('Deprecation');
  }

  if (lower.includes('renamed') || lower.includes('reorganize') || lower.includes('restructure')) {
    markers.push('Reorganization');
  }

  if (lower.includes('std::exception') || lower.includes('standard_failure')) {
    markers.push('Exception Handling');
  }

  if (lower.includes('std::mutex') || lower.includes('standard_mutex')) {
    markers.push('Threading');
  }

  if (lower.includes('final')) {
    markers.push('Class Hierarchy');
  }

  return markers;
}

async function main(): Promise<void> {
  console.log('Gathering tag metadata from local OCCT repo...');
  const totalCommits = getCommitCount(baseTag, allTags.at(-1)!);
  console.log(`Total commits ${baseTag}..${allTags.at(-1)!}: ${totalCommits}`);

  const tags: TagInfo[] = [];
  let previousTag = baseTag;

  for (const tag of allTags) {
    console.log(`Processing ${tag}...`);
    const date = getTagDate(tag);
    const commitCount = getCommitCount(previousTag, tag);
    const body = fetchReleaseBody(tag);
    tags.push({ tag, date, commitCount, body });
    previousTag = tag;
  }

  console.log('Generating changelog markdown...');

  const lines: string[] = [];

  lines.push('# OpenCASCADE Technology Changelog: V7.6.2 → V8.0.0-rc4');
  lines.push('');
  lines.push('> Comprehensive changelog covering 14 releases and 1,085 commits relevant to the');
  lines.push('> opencascade.js WASM binding upgrade from OCCT V7.6.2 to V8.0.0-rc4.');
  lines.push('>');
  lines.push(`> Generated on ${new Date().toISOString().split('T')[0]} from`);
  lines.push(`> [${repo}](https://github.com/${repo}) release notes and local git history.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Summary table
  lines.push('## Release Summary');
  lines.push('');
  lines.push('| Version | Date | Commits | Type |');
  lines.push('|---------|------|---------|------|');

  for (const t of tags) {
    const type = t.tag.includes('rc') ? 'Release Candidate' : t.tag.endsWith('_0') ? 'Minor' : 'Maintenance';
    lines.push(`| ${formatTag(t.tag)} | ${t.date} | ${t.commitCount} | ${type} |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // Breaking changes summary for opencascade.js
  lines.push('## Breaking Changes Impact on opencascade.js Bindings');
  lines.push('');
  lines.push('The following breaking changes are particularly relevant to the opencascade.js');
  lines.push('WASM binding generation and runtime:');
  lines.push('');
  lines.push('### Build Requirements');
  lines.push('');
  lines.push('- **C++17 minimum** (V8.0.0-rc2, [#537](https://github.com/Open-Cascade-SAS/OCCT/pull/537)):');
  lines.push('  Emscripten must be upgraded to a version supporting C++17. Current Emscripten 3.1.14');
  lines.push('  supports C++17 but upgrading to 4.x is recommended for full compliance.');
  lines.push('');
  lines.push('### Repository Structure');
  lines.push('');
  lines.push(
    '- **Source directory reorganized** (V8.0.0-rc1, [#450](https://github.com/Open-Cascade-SAS/OCCT/pull/450)):',
  );
  lines.push('  Layout changed from `src/Package/` to `src/Module/Toolkit/Package/File`.');
  lines.push('  All binding generation scripts that enumerate source files (`compileSources.py`,');
  lines.push('  `Common.py`) must be updated to handle the new directory structure.');
  lines.push('');
  lines.push('### Exception Handling');
  lines.push('');
  lines.push(
    '- **`Standard_Failure` inherits `std::exception`** (V8.0.0-rc4, [#984](https://github.com/Open-Cascade-SAS/OCCT/pull/984)):',
  );
  lines.push('  The exception hierarchy is now bridged with standard C++. `Raise()`, `Instance()`,');
  lines.push('  `Throw()` static methods are removed — use `throw` instead. This affects how');
  lines.push("  exceptions are caught in JavaScript via Emscripten's exception handling.");
  lines.push('');
  lines.push(
    '- **Thread-local error handlers** (V8.0.0-rc4, [#980](https://github.com/Open-Cascade-SAS/OCCT/pull/980)):',
  );
  lines.push('  Replaces global mutex-protected stack with `thread_local` storage. `Catches()` and');
  lines.push('  `LastCaughtError()` methods removed. The `OCC_CATCH_SIGNALS` macro is updated.');
  lines.push('');
  lines.push('### API Removals & Changes');
  lines.push('');
  lines.push('- **Deprecated math globals** (V8.0.0-rc3, [#833](https://github.com/Open-Cascade-SAS/OCCT/pull/833)):');
  lines.push('  `ACos()`, `Sqrt()`, `Sin()`, `Min()`, `Max()` etc. replaced with `std::` equivalents.');
  lines.push('  Bindings that expose these global functions will need updating.');
  lines.push('');
  lines.push(
    '- **`Standard_Mutex` replaced with `std::mutex`** (V8.0.0-rc3, [#766](https://github.com/Open-Cascade-SAS/OCCT/pull/766)):',
  );
  lines.push('  `Standard_Mutex::Sentry` → `std::lock_guard`. `TopTools_MutexForShapeProvider` removed.');
  lines.push('');
  lines.push('- **`PLib_Base` removed** (V8.0.0-rc3, [#795](https://github.com/Open-Cascade-SAS/OCCT/pull/795)):');
  lines.push('  `PLib_JacobiPolynomial` and `PLib_HermitJacobi` are now value types, not Handle-based.');
  lines.push('');
  lines.push(
    '- **All 29 leaf Geom/Geom2d classes marked `final`** (V8.0.0-rc4, [#1063](https://github.com/Open-Cascade-SAS/OCCT/pull/1063)):',
  );
  lines.push('  Prevents virtual method overrides. Binding generation filters may need updating');
  lines.push('  to avoid attempting to extend these classes.');
  lines.push('');
  lines.push(
    '- **`NCollection_Map::Seek()`/`ChangeSeek()` removed** (V8.0.0-rc4, [#1065](https://github.com/Open-Cascade-SAS/OCCT/pull/1065)):',
  );
  lines.push('  Replaced with `Contained()` returning `std::optional`.');
  lines.push('');
  lines.push(
    '- **`Standard_Failure::Raise()` static method removed** (V8.0.0-rc4, [#984](https://github.com/Open-Cascade-SAS/OCCT/pull/984)):',
  );
  lines.push('  Use `throw` instead. This affects any binding that wraps these methods.');
  lines.push('');
  lines.push(
    '- **BSpline/Bezier weights always populated** (V8.0.0-rc4, [#1058](https://github.com/Open-Cascade-SAS/OCCT/pull/1058)):',
  );
  lines.push('  Nullable `Weights()` replaced with always-valid `WeightsArray()`.');
  lines.push('');
  lines.push(
    '- **Mesh plugin system replaced** (V8.0.0-rc4, [#1033](https://github.com/Open-Cascade-SAS/OCCT/pull/1033)):',
  );
  lines.push('  `BRepMesh_PluginMacro.hxx`, `BRepMesh_PluginEntryType.hxx`, `BRepMesh_FactoryError.hxx`');
  lines.push('  removed. Registry-based factory pattern introduced.');
  lines.push('');
  lines.push('### New Collections & Types');
  lines.push('');
  lines.push('- **`NCollection_FlatDataMap`/`FlatMap`** (V8.0.0-rc4): Robin Hood hash maps');
  lines.push('- **`NCollection_OrderedMap`/`OrderedDataMap`** (V8.0.0-rc4): Insertion-order-preserving maps');
  lines.push('- **`NCollection_KDTree`** (V8.0.0-rc4): Header-only spatial KD-Tree');
  lines.push('- **`gp_Dir::D` enumerations** (V8.0.0-rc3): Standard direction enums');
  lines.push('- **`TCollection_AsciiString::EmptyString()`** (V8.0.0-rc3): Static empty string accessor');
  lines.push('');
  lines.push('### Typedef Deprecation');
  lines.push('');
  lines.push('- Package type aliases (`TColStd_*`, `TopTools_*`, etc.) are deprecated in favor of');
  lines.push(
    '  `NCollection_*<T>` templates (V8.0.0-rc4, [#1026](https://github.com/Open-Cascade-SAS/OCCT/pull/1026)).',
  );
  lines.push('  The `ignoreDuplicateTypedef()` filter in opencascade.js binding generation will');
  lines.push('  need updating for new/changed typedef spellings.');
  lines.push('');
  lines.push('### TopoDS_TShape Overhaul');
  lines.push('');
  lines.push(
    '- **Child storage changed from linked list to contiguous array** (V8.0.0-rc4, [#1027](https://github.com/Open-Cascade-SAS/OCCT/pull/1027)):',
  );
  lines.push('  `ShapeType()` devirtualized, state bit-packed into `uint16_t`, iterator changed');
  lines.push('  from list-based to index-based. Any code directly accessing TShape internals');
  lines.push('  through bindings will need adaptation.');
  lines.push('');
  lines.push('### Geometry Evaluation Redesign');
  lines.push('');
  lines.push(
    '- **New `EvalD*` API** (V8.0.0-rc4, [#1064](https://github.com/Open-Cascade-SAS/OCCT/pull/1064), [#1094](https://github.com/Open-Cascade-SAS/OCCT/pull/1094)):',
  );
  lines.push('  New virtual `EvalD0`/`EvalD1`/`EvalD2`/`EvalD3` methods with POD result structs.');
  lines.push('  Old `D0`/`D1`/`D2`/`D3` methods retained as non-virtual inline wrappers.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Per-release detailed notes
  lines.push('## Detailed Release Notes');
  lines.push('');

  for (const t of tags) {
    const version = formatTag(t.tag);
    const breakingMarkers = classifyBreakingChange(t.body);
    const breakingBadge = breakingMarkers.length > 0 ? ` ⚠️ ${breakingMarkers.join(', ')}` : '';

    lines.push(`### ${version} (${t.date}, ${t.commitCount} commits)${breakingBadge}`);
    lines.push('');
    lines.push(
      `[GitHub Release](https://github.com/${repo}/releases/tag/${t.tag}) · [Full Changelog](https://github.com/${repo}/compare/${t === tags[0] ? baseTag : (tags[tags.indexOf(t) - 1]?.tag ?? baseTag)}...${t.tag})`,
    );
    lines.push('');
    lines.push(t.body);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const markdown = lines.join('\n');
  await writeFile(outputFile, markdown, 'utf8');
  console.log(`Changelog written to ${outputFile}`);
  console.log(`Total: ${tags.length} releases, ${totalCommits} commits`);
}

await main().catch((error: unknown) => {
  console.error('Failed to generate changelog:', error);
  throw error;
});
