import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  review_key TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  pr_id TEXT,
  status TEXT NOT NULL DEFAULT 'capturing',
  storybook_url TEXT,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS builds_review ON builds(review_key, commit_sha);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id INTEGER NOT NULL REFERENCES builds(id),
  story_id TEXT NOT NULL,
  title TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  hash TEXT NOT NULL,
  base_hash TEXT,
  width INTEGER,
  height INTEGER,
  diff_pixels INTEGER,
  diff_ratio REAL,
  has_diff INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new',
  decided_by TEXT,
  decided_at TEXT,
  error TEXT,
  diff_threshold REAL,
  inherited INTEGER NOT NULL DEFAULT 0,
  UNIQUE(build_id, story_id, mode)
);

CREATE TABLE IF NOT EXISTS baselines (
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  story_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  hash TEXT NOT NULL,
  commit_sha TEXT,
  accepted_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project, branch, story_id, mode)
);

CREATE TABLE IF NOT EXISTS verdicts (
  review_key TEXT NOT NULL,
  user TEXT NOT NULL,
  verdict TEXT NOT NULL,
  signature TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (review_key, user)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_key TEXT NOT NULL,
  story_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  project TEXT NOT NULL,
  user TEXT NOT NULL,
  body TEXT NOT NULL,
  x REAL,
  y REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'lookout.sqlite'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}
