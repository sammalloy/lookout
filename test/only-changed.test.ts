import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalizeConfig } from '@lookout/core';
import { openDb } from '../packages/server/src/db.ts';
import { Storage } from '../packages/server/src/storage.ts';
import { Lookout } from '../packages/server/src/service.ts';
import { createApp } from '../packages/server/src/http.ts';
import { LookoutClient } from '../packages/cli/src/client.ts';
import { runProject } from '../packages/cli/src/run.ts';
import { writeFakeStorybook } from './fixtures/fake-storybook.ts';

// A monorepo: the design system in packages/ui, an app in apps/checkout that imports it from source.
const repo = mkdtempSync(join(tmpdir(), 'lookout-turbosnap-'));
let server: Server;
let client: LookoutClient;
const logs: string[] = [];

const config = normalizeConfig({
  modes: { viewports: [{ name: 'desktop', width: 800, height: 300 }], themes: ['light', 'dark'] },
  concurrency: 2,
  onlyChanged: true,
});

const projects = {
  'design-system': { dir: join(repo, 'packages/ui') },
  checkout: { dir: join(repo, 'apps/checkout') },
};

async function run(
  name: keyof typeof projects,
  color: string,
  git: { branch: string; commit: string; prId: string | null },
  changedFiles: string[],
) {
  const root = projects[name].dir;
  const storybook = join(root, 'storybook-static');
  writeFakeStorybook(storybook, { project: name, buttonColor: color });
  return runProject({
    project: { name, storybook, root },
    config,
    client,
    git: { ...git, baseBranch: 'main' },
    onlyChanged: true,
    changedFiles,
    repoRoot: repo,
    log: msg => logs.push(msg),
  });
}

before(async () => {
  const dataDir = join(repo, '.data');
  const storage = new Storage(dataDir);
  server = createApp(new Lookout(openDb(dataDir), storage, 'http://lookout.test', () => {}), storage);
  await new Promise<void>(r => server.listen(0, r));
  client = new LookoutClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

after(() => {
  server.close();
  rmSync(repo, { recursive: true, force: true });
});

const review = (key: string) => client['call']<any>('GET', `/api/reviews/${key}`);

test('the first build captures everything', async () => {
  const ds = await run('design-system', '#3b5bdb', { branch: 'main', commit: 'm1', prId: null }, []);
  const app = await run('checkout', '#3b5bdb', { branch: 'main', commit: 'm1', prId: null }, []);
  assert.equal(ds.captured, 6);
  assert.equal(app.captured, 4);
  assert.ok(logs.some(l => l.includes('no earlier build')));
});

test('a component change only captures stories that import it, in every project', async () => {
  const git = { branch: 'feature/textfield', commit: 'f1', prId: '9' };
  const ds = await run('design-system', '#3b5bdb', git, ['packages/ui/src/TextField.jsx']);
  const app = await run('checkout', '#3b5bdb', git, ['packages/ui/src/TextField.jsx']);
  assert.equal(ds.captured, 2, 'TextField story in 2 modes');
  assert.equal(ds.inherited, 4);
  assert.equal(app.captured, 2, 'Address story uses TextField');
  assert.equal(app.inherited, 2);
  assert.deepEqual(ds.counts, { unchanged: 6 });
});

test('changes are still detected, and the review has every snapshot', async () => {
  const git = { branch: 'feature/textfield', commit: 'f2', prId: '9' };
  const ds = await run('design-system', '#e8590c', git, ['packages/ui/src/Button.jsx']);
  const app = await run('checkout', '#e8590c', git, ['packages/ui/src/Button.jsx']);
  assert.equal(ds.captured, 4, 'both Button stories');
  assert.deepEqual(ds.counts, { changed: 2, unchanged: 4 });
  assert.equal(app.captured, 2, 'Summary story uses Button');
  assert.deepEqual(app.counts, { changed: 2, unchanged: 2 });

  const r = await review('pr-9');
  assert.equal(r.snapshots.length, 10);
  assert.equal(r.snapshots.filter((s: any) => s.inherited).length, 4);
  assert.equal(r.statuses[0].description, '4 visual changes to review');
});

test('files outside the Storybook bundle capture nothing', async () => {
  const ds = await run('design-system', '#e8590c', { branch: 'feature/textfield', commit: 'f3', prId: '9' }, ['README.md']);
  assert.equal(ds.captured, 0);
  assert.equal(ds.inherited, 6);
  assert.deepEqual(ds.counts, { changed: 2, unchanged: 4 });
});

test('global styles, Storybook config and dependencies capture everything', async () => {
  for (const file of ['packages/ui/src/tokens.css', 'packages/ui/.storybook/main.js', 'package-lock.json', 'apps/checkout/package.json']) {
    const ds = await run('design-system', '#e8590c', { branch: 'feature/textfield', commit: `g-${file}`, prId: '9' }, [file]);
    assert.equal(ds.captured, 6, `${file} should capture everything`);
    assert.equal(ds.inherited, 0);
  }
});
