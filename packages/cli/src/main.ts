#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '@lookout/core';
import { LookoutClient } from './client.ts';
import { runProject } from './run.ts';
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
  --only-changed       only capture stories affected by changes since the last build
                       (TurboSnap-style; needs \`storybook build --stats-json\`)
  --all                capture every story even if onlyChanged is on in the config
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
    'only-changed': { type: 'boolean' },
    all: { type: 'boolean', default: false },
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
  const storybook = resolve(values.storybook);
  projects = [{ name: values.project, storybook, root: dirname(storybook) }];
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

const onlyChanged = !values.all && (values['only-changed'] ?? config.onlyChanged.enabled);

for (const project of projects) {
  const summary = await runProject({
    project,
    config,
    client,
    git: { branch, baseBranch, commit, prId },
    onlyChanged,
  });
  reviewUrl = summary.reviewUrl;
  needsReview += (summary.counts.new ?? 0) + (summary.counts.changed ?? 0);
  failed += summary.counts.error ?? 0;
}

console.log(`\nReview: ${reviewUrl}`);
if (values['exit-code'] && (needsReview > 0 || failed > 0)) process.exit(1);
