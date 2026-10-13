import type { LookoutConfig, Mode, ProjectConfig } from '@lookout/core';
import { captureStorybook, readStoryIndex, type StoryEntry } from './capture.ts';
import type { LookoutClient } from './client.ts';
import { changedFilesSince, repoRoot } from './git.ts';
import { selectStories } from './turbosnap.ts';

export interface RunInput {
  project: ProjectConfig;
  config: LookoutConfig;
  client: LookoutClient;
  git: { branch: string; baseBranch: string; commit: string; prId: string | null };
  onlyChanged: boolean;
  /** Override git for tests: files changed since the baseline build's commit. */
  changedFiles?: string[];
  /** Override the git repository root (tests). */
  repoRoot?: string;
  log?: (msg: string) => void;
}

interface Plan {
  filter?: (story: StoryEntry, mode: Mode) => boolean;
  inherit?: { fromBuild: number; snapshots: Array<{ storyId: string; mode: string }> };
}

/** Decide which snapshots to capture and which to carry over from the last build. */
async function planOnlyChanged(input: RunInput, log: (msg: string) => void): Promise<Plan> {
  const { project, config, client, git } = input;
  const full = (why: string): Plan => {
    log(`  onlyChanged: capturing everything, ${why}`);
    return {};
  };

  const last = await client.lastBuild(project.name, git.branch, git.baseBranch);
  if (!last.build) return full('no earlier build to compare with');
  const changed = input.changedFiles ?? changedFilesSince(last.build.commit);
  if (!changed) {
    return full(`commit ${last.build.commit.slice(0, 8)} isn't in local git history (fetch more history in CI)`);
  }

  const stories = readStoryIndex(project.storybook);
  const selection = selectStories({
    storybookDir: project.storybook,
    projectRoot: project.root,
    repoRoot: input.repoRoot ?? repoRoot() ?? project.root,
    changedFiles: changed,
    stories,
    fullRebuildOn: config.onlyChanged.fullRebuildOn,
  });
  if (selection.full) return full(selection.reason);

  const prior = new Map(last.snapshots.map(s => [`${s.storyId}|${s.mode}`, s.state]));
  const capture = (story: StoryEntry, mode: Mode) => {
    const state = prior.get(`${story.id}|${mode.name}`);
    return selection.storyIds.has(story.id) || state === undefined || state === 'error';
  };
  const inherit = stories.flatMap(story =>
    config.modes.filter(mode => !capture(story, mode)).map(mode => ({ storyId: story.id, mode: mode.name })),
  );
  log(
    `  onlyChanged: ${changed.length} file(s) changed since ${last.build.commit.slice(0, 8)}; ` +
      `${selection.storyFiles.length} story file(s) affected` +
      (selection.storyFiles.length ? ` (${selection.storyFiles.join(', ')})` : ''),
  );
  return { filter: capture, inherit: { fromBuild: last.build.id, snapshots: inherit } };
}

export async function runProject(input: RunInput) {
  const { project, config, client, git } = input;
  const log = input.log ?? console.log;
  const started = Date.now();
  const build = await client.createBuild({ project: project.name, ...git, config });
  log(`[${project.name}] build ${build.id} on ${git.branch}@${git.commit.slice(0, 8)}${git.prId ? ` (PR ${git.prId})` : ''}`);

  const plan = input.onlyChanged ? await planOnlyChanged(input, log) : {};
  const result = await captureStorybook({
    storybookDir: project.storybook,
    config,
    filter: plan.filter,
    onShot: async shot => {
      if (shot.error) log(`  ! ${shot.story.id} [${shot.mode.name}]: ${shot.error}`);
      await client.uploadShot(build.id, shot);
    },
  });
  const summary = await client.finalize(build.id, plan.inherit);
  const reused = summary.inherited ? `, ${summary.inherited} reused from the last build` : '';
  log(
    `[${project.name}] ${result.stories} stories: captured ${result.captured}${reused} in ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s: ` +
      Object.entries(summary.counts).map(([k, v]) => `${v} ${k}`).join(', '),
  );
  return { ...summary, reviewUrl: build.url, captured: result.captured };
}
