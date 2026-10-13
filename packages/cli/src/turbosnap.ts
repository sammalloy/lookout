import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { matchGlob } from '@lookout/core';
import type { StoryEntry } from './capture.ts';

/**
 * TurboSnap-style story selection: given the files changed since the baseline build,
 * work out which stories could look different, using the module graph Storybook writes
 * with `storybook build --stats-json` (preview-stats.json).
 */

export type Selection =
  | { full: true; reason: string }
  | { full: false; storyIds: Set<string>; storyFiles: string[]; changedFiles: string[] };

export interface SelectionInput {
  /** Built Storybook directory (contains index.json and preview-stats.json). */
  storybookDir: string;
  /** Directory Storybook was built from; module paths in the stats are relative to it. */
  projectRoot: string;
  /** Git repository root; changed files are relative to it. */
  repoRoot: string;
  /** Files changed since the baseline commit, relative to repoRoot. */
  changedFiles: string[];
  stories: StoryEntry[];
  /** Globs (relative to repoRoot) that force a full capture when changed. */
  fullRebuildOn: string[];
}

interface StatsModule {
  id?: string | number;
  name: string;
  reasons?: Array<{ moduleName: string }>;
}

const toPosix = (p: string) => p.split(sep).join('/');

/** Map a stats module name to a repo-relative path, or null for virtual/generated modules. */
function moduleToRepoPath(name: string, projectRoot: string, repoRoot: string): string | null {
  // Webpack names can carry loaders ("css-loader!./src/x.css") or a " + 3 modules" suffix.
  const clean = name.split('!').pop()!.replace(/ \+ \d+ modules?$/, '').split('?')[0];
  if (!clean.startsWith('.') && !clean.startsWith('/')) return null;
  if (clean.startsWith('/virtual:') || clean.includes('__vite-')) return null;
  const abs = clean.startsWith('/') ? clean : resolve(projectRoot, clean);
  const rel = toPosix(relative(repoRoot, abs));
  return rel.startsWith('..') ? null : rel;
}

export function selectStories(input: SelectionInput): Selection {
  const statsFile = join(input.storybookDir, 'preview-stats.json');
  if (!existsSync(statsFile)) {
    return { full: true, reason: 'no preview-stats.json (build Storybook with --stats-json)' };
  }

  const forced = input.changedFiles.find(f => input.fullRebuildOn.some(g => matchGlob(g, f)));
  if (forced) return { full: true, reason: `${forced} changed` };

  const stats = JSON.parse(readFileSync(statsFile, 'utf8')) as { modules: StatsModule[] };

  // importer graph: file -> files that import it
  const importers = new Map<string, Set<string>>();
  for (const m of stats.modules) {
    const self = moduleToRepoPath(m.name, input.projectRoot, input.repoRoot);
    if (!self) continue;
    if (!importers.has(self)) importers.set(self, new Set());
    for (const r of m.reasons ?? []) {
      const by = moduleToRepoPath(r.moduleName, input.projectRoot, input.repoRoot);
      if (by && by !== self) importers.get(self)!.add(by);
    }
  }

  const storyFileToIds = new Map<string, string[]>();
  for (const s of input.stories) {
    if (!s.importPath) return { full: true, reason: 'index.json has no importPath (Storybook 7+ needed)' };
    const file = moduleToRepoPath(s.importPath, input.projectRoot, input.repoRoot);
    if (!file) continue;
    storyFileToIds.set(file, [...(storyFileToIds.get(file) ?? []), s.id]);
  }

  const configDir = toPosix(relative(input.repoRoot, join(input.projectRoot, '.storybook')));
  const affectedFiles = new Set<string>();
  for (const changed of input.changedFiles) {
    if (changed.startsWith(`${configDir}/`)) return { full: true, reason: `${changed} changed (Storybook config)` };
    if (!importers.has(changed)) continue; // not part of the Storybook bundle
    const seen = new Set<string>([changed]);
    const queue = [changed];
    while (queue.length) {
      const file = queue.shift()!;
      if (file.startsWith(`${configDir}/`)) {
        return { full: true, reason: `${changed} is used by ${file}, which applies to every story` };
      }
      if (storyFileToIds.has(file)) affectedFiles.add(file);
      for (const by of importers.get(file) ?? []) {
        if (!seen.has(by)) {
          seen.add(by);
          queue.push(by);
        }
      }
    }
  }

  const storyIds = new Set<string>();
  for (const f of affectedFiles) for (const id of storyFileToIds.get(f)!) storyIds.add(id);
  return { full: false, storyIds, storyFiles: [...affectedFiles].sort(), changedFiles: input.changedFiles };
}
