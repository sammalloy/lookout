import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalizeConfig } from '@lookout/core';
import { openDb } from '../packages/server/src/db.ts';
import { Storage } from '../packages/server/src/storage.ts';
import { Lookout } from '../packages/server/src/service.ts';
import { createApp } from '../packages/server/src/http.ts';
import { captureStorybook } from '../packages/cli/src/capture.ts';
import { LookoutClient } from '../packages/cli/src/client.ts';
import { writeFakeStorybook } from './fixtures/fake-storybook.ts';

const tmp = mkdtempSync(join(tmpdir(), 'lookout-e2e-'));
let server: Server;
let bitbucket: Server;
let base = '';
const posted: Array<{ url: string; body: any }> = [];

const config = normalizeConfig({
  projects: [],
  modes: { viewports: [{ name: 'desktop', width: 800, height: 300 }], themes: ['light', 'dark'] },
  concurrency: 2,
  reviewers: {
    default: ['@design-system-team'],
    groups: { 'design-system-team': ['alice', 'bob'] },
    rules: [{ match: 'checkout/**', reviewers: ['carol'] }],
  },
  bitbucket: { kind: 'cloud', workspace: 'acme', repo: 'ui' },
});

async function upload(project: 'design-system' | 'checkout', color: string, git: { branch: string; commit: string; prId: string | null }) {
  const dir = join(tmp, `${project}-${color.replace('#', '')}`);
  writeFakeStorybook(dir, { project, buttonColor: color });
  const client = new LookoutClient(base);
  const build = await client.createBuild({ project, ...git, baseBranch: 'main', config });
  await captureStorybook({ storybookDir: dir, config, onShot: shot => client.uploadShot(build.id, shot) as Promise<any> });
  return client.finalize(build.id);
}

const getReview = (key: string) => fetch(`${base}/api/reviews/${key}`).then(r => r.json());
const post = (path: string, body: object) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

before(async () => {
  bitbucket = createServer((req, res) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      posted.push({ url: req.url!, body: JSON.parse(data) });
      res.writeHead(201).end('{}');
    });
  });
  await new Promise<void>(r => bitbucket.listen(0, r));
  process.env.BITBUCKET_API_URL = `http://127.0.0.1:${(bitbucket.address() as AddressInfo).port}`;

  const dataDir = join(tmp, 'data');
  const storage = new Storage(dataDir);
  server = createApp(new Lookout(openDb(dataDir), storage, 'http://lookout.test', () => {}), storage);
  await new Promise<void>(r => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  bitbucket.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('main builds become baselines automatically', async () => {
  const ds = await upload('design-system', '#3b5bdb', { branch: 'main', commit: 'c1', prId: null });
  const app = await upload('checkout', '#3b5bdb', { branch: 'main', commit: 'c1', prId: null });
  // 3 enabled stories x 2 modes; the disabled Spinner and the docs entry are skipped.
  assert.deepEqual(ds.counts, { accepted: 6 });
  assert.deepEqual(app.counts, { accepted: 4 });
});

test('a design-system change shows its impact on the design system and the app', async () => {
  const git = { branch: 'feature/button-colour', commit: 'c2', prId: '7' };
  const ds = await upload('design-system', '#e8590c', git);
  const app = await upload('checkout', '#e8590c', git);
  assert.deepEqual(ds.counts, { changed: 2, unchanged: 4 });
  assert.deepEqual(app.counts, { changed: 2, unchanged: 2 });

  const review = await getReview('pr-7');
  const changed = review.snapshots.filter((s: any) => s.state === 'changed').map((s: any) => `${s.project}:${s.storyId}:${s.mode}`);
  assert.deepEqual(changed.sort(), [
    'checkout:checkout-summary--default:desktop-dark',
    'checkout:checkout-summary--default:desktop-light',
    'design-system:components-button--primary:desktop-dark',
    'design-system:components-button--primary:desktop-light',
  ]);
  assert.ok(review.snapshots.find((s: any) => s.state === 'changed').hasDiff);

  // Default reviewers plus the checkout owners are required.
  assert.deepEqual(review.approval.requirements.map((r: any) => r.rule), ['default', 'checkout/**']);
  const statuses = Object.fromEntries(review.statuses.map((s: any) => [s.key, s.state]));
  assert.deepEqual(statuses, { 'lookout-visual': 'INPROGRESS', 'lookout-review': 'INPROGRESS' });
});

test('accepting and approving turns both Bitbucket statuses green', async () => {
  let review = await getReview('pr-7');
  const ids = review.snapshots.filter((s: any) => s.state === 'changed').map((s: any) => s.id);
  await post('/api/snapshots/batch/accept', { user: 'alice', ids });
  await post('/api/reviews/pr-7/verdict', { user: 'alice', verdict: 'approved' });
  review = await getReview('pr-7');
  assert.equal(review.approval.approved, false, 'checkout rule still needs carol');

  review = await post('/api/reviews/pr-7/verdict', { user: 'carol', verdict: 'approved' });
  assert.equal(review.approval.approved, true);
  const last = (key: string) => posted.filter(p => p.body.key === key && p.url.includes('/commit/c2/')).at(-1)!.body;
  assert.equal(last('lookout-visual').state, 'SUCCESSFUL');
  assert.equal(last('lookout-review').state, 'SUCCESSFUL');
  assert.match(posted[0].url, /^\/repositories\/acme\/ui\/commit\/c1\/statuses\/build$/);
});

test('a new push keeps accepted snapshots and approvals when screenshots are the same', async () => {
  const git = { branch: 'feature/button-colour', commit: 'c3', prId: '7' };
  const ds = await upload('design-system', '#e8590c', git);
  await upload('checkout', '#e8590c', git);
  assert.deepEqual(ds.counts, { accepted: 2, unchanged: 4 });
  const review = await getReview('pr-7');
  assert.equal(review.commit, 'c3');
  assert.equal(review.approval.approved, true);
});

test('a push that changes the screenshots again resets approval', async () => {
  const git = { branch: 'feature/button-colour', commit: 'c4', prId: '7' };
  await upload('design-system', '#c2255c', git);
  await upload('checkout', '#c2255c', git);
  const review = await getReview('pr-7');
  assert.equal(review.approval.approved, false);
  assert.equal(review.approval.approvals.length, 0);
  const visual = review.statuses.find((s: any) => s.key === 'lookout-visual');
  assert.equal(visual.state, 'INPROGRESS');
  assert.match(visual.description, /4 visual changes to review/);
});

test('denying a change fails the visual status', async () => {
  const review = await getReview('pr-7');
  const id = review.snapshots.find((s: any) => s.state === 'changed').id;
  const after = await post(`/api/snapshots/${id}/deny`, { user: 'bob' });
  assert.equal(after.statuses.find((s: any) => s.key === 'lookout-visual').state, 'FAILED');
});
