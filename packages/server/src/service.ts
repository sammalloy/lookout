import { createHash } from 'node:crypto';
import {
  diffPngs,
  hashPng,
  evaluateApprovals,
  type ApprovalOutcome,
  type CommitStatus,
  type LookoutConfig,
  type SnapshotState,
} from '@lookout/core';
import type { DB } from './db.ts';
import type { Storage } from './storage.ts';
import { postStatus } from './bitbucket.ts';

export interface BuildRow {
  id: number;
  project: string;
  review_key: string;
  branch: string;
  base_branch: string;
  commit_sha: string;
  pr_id: string | null;
  status: string;
  storybook_url: string | null;
  config: string;
  created_at: string;
}

export interface SnapshotRow {
  id: number;
  build_id: number;
  story_id: string;
  title: string;
  name: string;
  mode: string;
  hash: string;
  base_hash: string | null;
  width: number | null;
  height: number | null;
  diff_pixels: number | null;
  diff_ratio: number | null;
  has_diff: number;
  state: SnapshotState;
  decided_by: string | null;
  decided_at: string | null;
  error: string | null;
  diff_threshold: number | null;
}

export interface CreateBuildInput {
  project: string;
  branch: string;
  baseBranch?: string;
  commit: string;
  prId?: string | null;
  storybookUrl?: string | null;
  config: LookoutConfig;
}

/** Snapshots a reviewer has to look at: anything that differs from the base branch. */
const REVIEWABLE: SnapshotState[] = ['new', 'changed', 'accepted', 'denied'];

export function reviewKeyFor(prId: string | null | undefined, branch: string): string {
  return prId ? `pr-${prId}` : `branch-${branch}`;
}

export function snapshotPath(project: string, s: Pick<SnapshotRow, 'title' | 'name'>): string {
  return `${project}/${s.title}/${s.name}`;
}

export class Lookout {
  private db: DB;
  private storage: Storage;
  private publicUrl: string;
  private log: (msg: string) => void;

  constructor(db: DB, storage: Storage, publicUrl: string, log: (msg: string) => void = console.log) {
    this.db = db;
    this.storage = storage;
    this.publicUrl = publicUrl;
    this.log = log;
  }

  createBuild(input: CreateBuildInput): BuildRow {
    const baseBranch = input.baseBranch ?? input.config.baseBranch;
    const key = reviewKeyFor(input.prId, input.branch);
    const row = this.db
      .prepare(
        `INSERT INTO builds (project, review_key, branch, base_branch, commit_sha, pr_id, storybook_url, config)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        input.project,
        key,
        input.branch,
        baseBranch,
        input.commit,
        input.prId ?? null,
        input.storybookUrl ?? null,
        JSON.stringify(input.config),
      ) as unknown as BuildRow;
    return row;
  }

  getBuild(id: number): BuildRow | undefined {
    return this.db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as unknown as BuildRow | undefined;
  }

  addSnapshot(
    buildId: number,
    meta: { storyId: string; title: string; name: string; mode: string; error?: string; diffThreshold?: number },
    png?: Buffer,
  ) {
    const build = this.getBuild(buildId);
    if (!build) throw new HttpError(404, 'build not found');
    if (build.status !== 'capturing') throw new HttpError(409, 'build already finalized');
    let hash = '';
    if (png) {
      hash = hashPng(png);
      this.storage.putImage(hash, png);
    }
    this.db
      .prepare(
        `INSERT INTO snapshots (build_id, story_id, title, name, mode, hash, state, error, diff_threshold)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(build_id, story_id, mode) DO UPDATE SET hash = excluded.hash, error = excluded.error,
           diff_threshold = excluded.diff_threshold`,
      )
      .run(
        buildId, meta.storyId, meta.title, meta.name, meta.mode, hash,
        meta.error ? 'error' : 'new', meta.error ?? null, meta.diffThreshold ?? null,
      );
  }

  private baseline(project: string, branch: string, storyId: string, mode: string) {
    return this.db
      .prepare('SELECT hash FROM baselines WHERE project = ? AND branch = ? AND story_id = ? AND mode = ?')
      .get(project, branch, storyId, mode) as { hash: string } | undefined;
  }

  private setBaseline(project: string, branch: string, s: SnapshotRow, commit: string, user: string) {
    this.db
      .prepare(
        `INSERT INTO baselines (project, branch, story_id, mode, hash, commit_sha, accepted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, branch, story_id, mode) DO UPDATE SET
           hash = excluded.hash, commit_sha = excluded.commit_sha,
           accepted_by = excluded.accepted_by, updated_at = datetime('now')`,
      )
      .run(project, branch, s.story_id, s.mode, s.hash, commit, user);
  }

  /**
   * Compare every snapshot in the build with its baselines.
   *
   * Two baselines matter: the base branch's (what the PR will change) and the PR branch's
   * own (changes already accepted earlier in this PR, which carry forward to new commits).
   */
  async finalize(buildId: number) {
    const build = this.getBuild(buildId);
    if (!build) throw new HttpError(404, 'build not found');
    const config = JSON.parse(build.config) as LookoutConfig;
    const onBase = build.branch === build.base_branch;
    const snaps = this.db.prepare('SELECT * FROM snapshots WHERE build_id = ?').all(buildId) as unknown as SnapshotRow[];
    const update = this.db.prepare(
      `UPDATE snapshots SET state = ?, base_hash = ?, width = ?, height = ?, diff_pixels = ?, diff_ratio = ?,
         has_diff = ?, decided_by = ?, decided_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END
       WHERE id = ?`,
    );

    for (const s of snaps) {
      if (s.state === 'error') continue;
      const base = this.baseline(build.project, build.base_branch, s.story_id, s.mode);
      const own = onBase ? undefined : this.baseline(build.project, build.branch, s.story_id, s.mode);
      const current = this.storage.getImage(s.hash)!;
      let state: SnapshotState;
      let decidedBy: string | null = null;
      let diff = { diffPixels: 0, ratio: 0, width: 0, height: 0, diffPng: undefined as Buffer | undefined };

      if (!base) {
        state = 'new';
      } else {
        const prev = this.storage.getImage(base.hash)!;
        const threshold = s.diff_threshold ?? config.diffThreshold ?? 0.1;
        const r = diffPngs(prev, current, threshold);
        diff = { diffPixels: r.diffPixels, ratio: r.ratio, width: r.width, height: r.height, diffPng: r.diffPng };
        state = r.changed ? 'changed' : 'unchanged';
      }
      if (state !== 'unchanged' && own && own.hash === s.hash) {
        state = 'accepted';
        decidedBy = 'earlier commit';
      }
      if (state !== 'unchanged' && onBase && config.autoAcceptOnBaseBranch) {
        state = 'accepted';
        decidedBy = 'auto (base branch)';
        this.setBaseline(build.project, build.base_branch, s, build.commit_sha, decidedBy);
      }
      if (diff.diffPng) this.storage.putDiff(s.id, diff.diffPng);
      update.run(
        state,
        base?.hash ?? null,
        diff.width || null,
        diff.height || null,
        diff.diffPixels,
        diff.ratio,
        diff.diffPng ? 1 : 0,
        decidedBy,
        decidedBy,
        s.id,
      );
    }

    this.db.prepare(`UPDATE builds SET status = 'done' WHERE id = ?`).run(buildId);
    await this.publishStatuses(build.review_key);
    return this.buildSummary(buildId);
  }

  buildSummary(buildId: number) {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM snapshots WHERE build_id = ? GROUP BY state')
      .all(buildId) as Array<{ state: SnapshotState; n: number }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.state] = r.n;
    const build = this.getBuild(buildId)!;
    return { buildId, project: build.project, counts, url: this.reviewUrl(build.review_key) };
  }

  reviewUrl(key: string) {
    return `${this.publicUrl}/#/review/${encodeURIComponent(key)}`;
  }

  decide(snapshotId: number, decision: 'accepted' | 'denied' | 'reset', user: string) {
    const s = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId) as unknown as SnapshotRow | undefined;
    if (!s) throw new HttpError(404, 'snapshot not found');
    if (!['new', 'changed', 'accepted', 'denied'].includes(s.state)) {
      throw new HttpError(409, `cannot ${decision} a snapshot that is ${s.state}`);
    }
    const build = this.getBuild(s.build_id)!;
    const state: SnapshotState = decision === 'reset' ? (s.base_hash ? 'changed' : 'new') : decision;
    this.db
      .prepare(`UPDATE snapshots SET state = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`)
      .run(state, decision === 'reset' ? null : user, snapshotId);
    if (decision === 'accepted') {
      this.setBaseline(build.project, build.branch, s, build.commit_sha, user);
    } else {
      this.db
        .prepare('DELETE FROM baselines WHERE project = ? AND branch = ? AND story_id = ? AND mode = ? AND branch != ?')
        .run(build.project, build.branch, s.story_id, s.mode, build.base_branch);
    }
    return build.review_key;
  }

  /** The latest commit for a review and every project's latest build on it. */
  headBuilds(key: string): BuildRow[] {
    const head = this.db
      .prepare('SELECT commit_sha FROM builds WHERE review_key = ? ORDER BY id DESC LIMIT 1')
      .get(key) as { commit_sha: string } | undefined;
    if (!head) return [];
    const builds = this.db
      .prepare('SELECT * FROM builds WHERE review_key = ? AND commit_sha = ? ORDER BY id DESC')
      .all(key, head.commit_sha) as unknown as BuildRow[];
    const latest = new Map<string, BuildRow>();
    for (const b of builds) if (!latest.has(b.project)) latest.set(b.project, b);
    return [...latest.values()].sort((a, b) => a.project.localeCompare(b.project));
  }

  snapshotsFor(builds: BuildRow[]): Array<SnapshotRow & { project: string }> {
    if (builds.length === 0) return [];
    const byId = new Map(builds.map(b => [b.id, b.project]));
    const rows = this.db
      .prepare(`SELECT * FROM snapshots WHERE build_id IN (${builds.map(() => '?').join(',')}) ORDER BY title, name, mode`)
      .all(...builds.map(b => b.id)) as unknown as SnapshotRow[];
    return rows.map(r => ({ ...r, project: byId.get(r.build_id)! }));
  }

  /** Identity of the set of visual changes. Approvals survive pushes that don't change it. */
  private signature(snaps: Array<SnapshotRow & { project: string }>): string {
    const parts = snaps
      .filter(s => REVIEWABLE.includes(s.state))
      .map(s => `${s.project}|${s.story_id}|${s.mode}|${s.hash}`)
      .sort();
    return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
  }

  approval(key: string, builds = this.headBuilds(key)): ApprovalOutcome & { signature: string } {
    const snaps = this.snapshotsFor(builds);
    const config = this.configFor(builds);
    const signature = this.signature(snaps);
    const changedPaths = [
      ...new Set(snaps.filter(s => REVIEWABLE.includes(s.state)).map(s => snapshotPath(s.project, s))),
    ];
    let verdicts = this.db
      .prepare('SELECT user, verdict, signature FROM verdicts WHERE review_key = ?')
      .all(key) as Array<{ user: string; verdict: 'approved' | 'changes_requested'; signature: string }>;
    if (config?.review.dismissOnNewChanges !== false) verdicts = verdicts.filter(v => v.signature === signature);
    const outcome = config
      ? evaluateApprovals(config.review, changedPaths, verdicts)
      : { approved: true, changesRequested: [], requirements: [], approvals: [], missing: 0 };
    return { ...outcome, signature };
  }

  verdict(key: string, user: string, verdict: 'approved' | 'changes_requested') {
    const builds = this.headBuilds(key);
    if (builds.length === 0) throw new HttpError(404, 'review not found');
    const { signature } = this.approval(key, builds);
    this.db
      .prepare(
        `INSERT INTO verdicts (review_key, user, verdict, signature, commit_sha) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(review_key, user) DO UPDATE SET verdict = excluded.verdict, signature = excluded.signature,
           commit_sha = excluded.commit_sha, created_at = datetime('now')`,
      )
      .run(key, user, verdict, signature, builds[0].commit_sha);
  }

  private configFor(builds: BuildRow[]): LookoutConfig | undefined {
    const newest = [...builds].sort((a, b) => b.id - a.id)[0];
    return newest ? (JSON.parse(newest.config) as LookoutConfig) : undefined;
  }

  computeStatuses(key: string): { commit: string; statuses: CommitStatus[] } | undefined {
    const builds = this.headBuilds(key);
    if (builds.length === 0) return undefined;
    const snaps = this.snapshotsFor(builds);
    const url = this.reviewUrl(key);
    const count = (st: SnapshotState) => snaps.filter(s => s.state === st).length;
    const pending = count('new') + count('changed');
    const denied = count('denied');
    const errors = count('error');
    const accepted = count('accepted');

    let visual: CommitStatus;
    if (builds.some(b => b.status !== 'done')) {
      visual = { key: 'lookout-visual', state: 'INPROGRESS', name: 'Lookout: visual tests', description: 'Capturing and comparing screenshots', url };
    } else if (denied > 0 || errors > 0) {
      const parts = [denied && `${denied} denied`, errors && `${errors} failed to capture`].filter(Boolean);
      visual = { key: 'lookout-visual', state: 'FAILED', name: 'Lookout: visual tests', description: parts.join(', '), url };
    } else if (pending > 0) {
      visual = { key: 'lookout-visual', state: 'INPROGRESS', name: 'Lookout: visual tests', description: `${pending} visual change${pending === 1 ? '' : 's'} to review`, url };
    } else {
      visual = {
        key: 'lookout-visual',
        state: 'SUCCESSFUL',
        name: 'Lookout: visual tests',
        description: accepted ? `${accepted} change${accepted === 1 ? '' : 's'} accepted` : 'No visual changes',
        url,
      };
    }

    const statuses = [visual];
    if (key.startsWith('pr-')) {
      const a = this.approval(key, builds);
      let review: CommitStatus;
      if (a.changesRequested.length > 0) {
        review = { key: 'lookout-review', state: 'FAILED', name: 'Lookout: UI review', description: `Changes requested by ${a.changesRequested.join(', ')}`, url };
      } else if (a.approved) {
        review = {
          key: 'lookout-review',
          state: 'SUCCESSFUL',
          name: 'Lookout: UI review',
          description: a.requirements.length ? `Approved by ${a.approvals.join(', ')}` : 'Nothing to review',
          url,
        };
      } else {
        const waiting = a.requirements.filter(r => !r.satisfiedBy).map(r => r.reviewers.join(' or '));
        review = {
          key: 'lookout-review',
          state: 'INPROGRESS',
          name: 'Lookout: UI review',
          description: waiting.length ? `Waiting for ${waiting.join('; ')}` : `Needs ${a.missing} more approval${a.missing === 1 ? '' : 's'}`,
          url,
        };
      }
      statuses.push(review);
    }
    return { commit: builds[0].commit_sha, statuses };
  }

  async publishStatuses(key: string) {
    const computed = this.computeStatuses(key);
    if (!computed) return;
    const config = this.configFor(this.headBuilds(key));
    const bb = config?.bitbucket;
    if (!bb) return;
    for (const status of computed.statuses) {
      const kind = status.key === 'lookout-visual' ? 'visual' : 'review';
      if (!bb.statuses.includes(kind)) continue;
      try {
        await postStatus(bb, computed.commit, status);
      } catch (err) {
        this.log(`[lookout] ${(err as Error).message}`);
      }
    }
  }

  /** On merge, the PR branch's accepted snapshots become the destination's baselines. */
  promoteBranch(project: string | undefined, from: string, to: string) {
    const rows = this.db
      .prepare(`SELECT * FROM baselines WHERE branch = ? ${project ? 'AND project = ?' : ''}`)
      .all(...(project ? [from, project] : [from])) as Array<{ project: string; story_id: string; mode: string; hash: string; commit_sha: string; accepted_by: string }>;
    const upsert = this.db.prepare(
      `INSERT INTO baselines (project, branch, story_id, mode, hash, commit_sha, accepted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project, branch, story_id, mode) DO UPDATE SET hash = excluded.hash,
         commit_sha = excluded.commit_sha, accepted_by = excluded.accepted_by, updated_at = datetime('now')`,
    );
    for (const r of rows) upsert.run(r.project, to, r.story_id, r.mode, r.hash, r.commit_sha, r.accepted_by);
    return rows.length;
  }

  listReviews() {
    return this.db
      .prepare(
        `SELECT review_key, MAX(branch) AS branch, MAX(pr_id) AS pr_id, MAX(created_at) AS updated_at, MAX(id) AS last_build
         FROM builds GROUP BY review_key ORDER BY last_build DESC LIMIT 100`,
      )
      .all() as Array<{ review_key: string; branch: string; pr_id: string | null; updated_at: string }>;
  }

  review(key: string) {
    const builds = this.headBuilds(key);
    if (builds.length === 0) throw new HttpError(404, 'review not found');
    const snaps = this.snapshotsFor(builds);
    const comments = this.db
      .prepare('SELECT * FROM comments WHERE review_key = ? ORDER BY id')
      .all(key);
    return {
      key,
      prId: builds[0].pr_id,
      branch: builds[0].branch,
      baseBranch: builds[0].base_branch,
      commit: builds[0].commit_sha,
      builds: builds.map(b => ({ id: b.id, project: b.project, status: b.status, storybookUrl: b.storybook_url, createdAt: b.created_at })),
      snapshots: snaps.map(s => ({
        id: s.id,
        project: s.project,
        storyId: s.story_id,
        title: s.title,
        name: s.name,
        mode: s.mode,
        state: s.state,
        hash: s.hash,
        baseHash: s.base_hash,
        hasDiff: !!s.has_diff,
        diffRatio: s.diff_ratio,
        diffPixels: s.diff_pixels,
        decidedBy: s.decided_by,
        error: s.error,
      })),
      approval: key.startsWith('pr-') ? this.approval(key, builds) : null,
      statuses: this.computeStatuses(key)?.statuses ?? [],
      comments,
    };
  }

  addComment(key: string, c: { storyId: string; mode: string; project: string; user: string; body: string; x?: number; y?: number }) {
    this.db
      .prepare('INSERT INTO comments (review_key, story_id, mode, project, user, body, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(key, c.storyId, c.mode, c.project, c.user, c.body, c.x ?? null, c.y ?? null);
  }
}

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
