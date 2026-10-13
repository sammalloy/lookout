#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig } from '@lookout/core';
import { captureStorybook } from './capture.ts';
import { LookoutClient } from './client.ts';
import { detectGit } from './git.ts';

const HELP = `lookout: visual tests for Storybook

Usage:
  lookout run [options]                 capture every project in .lookout.yml
  lookout capture --project <name> --storybook <dir> [options]

Options:
  --config <file>      config file (default .lookout.yml)
  --project <name>     only this project (run) / project name (capture)
  --storybook <dir>    built Storybook directory (capture)
  --server <url>       Lookout server (default from config or LOOKOUT_SERVER)
  --branch, --commit, --pr, --base   override git / Bitbucket Pipelines detection
  --exit-code          exit 1 when changes need review or captures failed
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: '.lookout.yml' },
    project: { type: 'string' },
    storybook: { type: 'string' },
    server: { type: 'string' },
    branch: { type: 'string' },
    commit: { type: 'string' },
    pr: { type: 'string' },
    base: { type: 'string' },
    'exit-code': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];
if (values.help || !command || !['run', 'capture'].includes(command)) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const config = loadConfig(values.config);
if (values.server) config.server = values.server;
const git = detectGit();
const branch = values.branch ?? git.branch;
const commit = values.commit ?? git.commit;
const prId = values.pr ?? git.prId;
const baseBranch = values.base ?? git.baseBranch ?? config.baseBranch;

let projects = config.projects;
if (command === 'capture') {
  if (!values.project || !values.storybook) {
    console.error('capture needs --project and --storybook');
    process.exit(1);
  }
  projects = [{ name: values.project, storybook: resolve(values.storybook) }];
} else if (values.project) {
  projects = projects.filter(p => p.name === values.project);
}
if (projects.length === 0) {
  console.error('No projects to capture. Add "projects" to .lookout.yml or use `lookout capture`.');
  process.exit(1);
}

const client = new LookoutClient(config.server.replace(/\/$/, ''));
let needsReview = 0;
let failed = 0;
let reviewUrl = '';

for (const project of projects) {
  const started = Date.now();
  const build = await client.createBuild({ project: project.name, branch, baseBranch, commit, prId, config });
  reviewUrl = build.url;
  console.log(`[${project.name}] build ${build.id} on ${branch}@${commit.slice(0, 8)}${prId ? ` (PR ${prId})` : ''}`);
  const result = await captureStorybook({
    storybookDir: project.storybook,
    config,
    onShot: async shot => {
      if (shot.error) console.warn(`  ! ${shot.story.id} [${shot.mode.name}]: ${shot.error}`);
      await client.uploadShot(build.id, shot);
    },
  });
  const summary = await client.finalize(build.id);
  const c = summary.counts;
  needsReview += (c.new ?? 0) + (c.changed ?? 0);
  failed += c.error ?? 0;
  console.log(
    `[${project.name}] ${result.stories} stories, ${result.captured} snapshots in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
      Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', '),
  );
}

console.log(`\nReview: ${reviewUrl}`);
if (values['exit-code'] && (needsReview > 0 || failed > 0)) process.exit(1);
