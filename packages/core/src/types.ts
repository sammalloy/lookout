export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export interface Mode {
  /** Stable key such as "desktop" or "mobile-dark"; part of a snapshot's identity. */
  name: string;
  viewport: Viewport;
  /** Storybook globals passed in the iframe URL, e.g. { theme: "dark" }. */
  globals: Record<string, string>;
}

export interface ReviewerRule {
  /** Glob against "<project>/<story title>/<story name>", e.g. "design-system/Components/Button/**". */
  match: string;
  reviewers: string[];
}

export interface ReviewConfig {
  default: string[];
  rules: ReviewerRule[];
  groups: Record<string, string[]>;
  minimum: number;
  perRule: boolean;
  dismissOnNewChanges: boolean;
}

export interface ProjectConfig {
  name: string;
  /** Path to a built Storybook (the output of `storybook build`). */
  storybook: string;
  /** Directory Storybook is built from (holds .storybook/). Defaults to the parent of `storybook`. */
  root: string;
}

export interface OnlyChangedConfig {
  /** Only capture stories affected by files changed since the baseline build (TurboSnap-style). */
  enabled: boolean;
  /** Globs, relative to the repo root, that force capturing every story when changed. */
  fullRebuildOn: string[];
}

export type BitbucketKind = 'cloud' | 'datacenter';

export interface BitbucketConfig {
  kind: BitbucketKind;
  /** Cloud: workspace slug. Data Center: project key. */
  workspace: string;
  repo: string;
  /** Data Center only: base URL such as https://bitbucket.example.com */
  baseUrl?: string;
  /** Which statuses to post. Turn on the ones your merge check should require. */
  statuses: Array<'visual' | 'review'>;
}

export interface LookoutConfig {
  server: string;
  baseBranch: string;
  autoAcceptOnBaseBranch: boolean;
  projects: ProjectConfig[];
  modes: Mode[];
  diffThreshold: number;
  concurrency: number;
  onlyChanged: OnlyChangedConfig;
  review: ReviewConfig;
  bitbucket?: BitbucketConfig;
}

/** Per-story options, read from `parameters.lookout` in a story. */
export interface StoryOptions {
  disable?: boolean;
  delay?: number;
  ignoreSelectors?: string[];
  modes?: string[];
  diffThreshold?: number;
  /** "story" (default) crops to the rendered story; "page" captures the full page. */
  capture?: 'story' | 'page';
}

export type SnapshotState = 'unchanged' | 'new' | 'changed' | 'accepted' | 'denied' | 'error';

export type StatusState = 'INPROGRESS' | 'SUCCESSFUL' | 'FAILED';

export interface CommitStatus {
  key: 'lookout-visual' | 'lookout-review';
  state: StatusState;
  name: string;
  description: string;
  url: string;
}
