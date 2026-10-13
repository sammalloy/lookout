import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import type { LookoutConfig, Mode, ReviewConfig } from './types.ts';

const DEFAULT_MODES: Mode[] = [
  { name: 'desktop', viewport: { name: 'desktop', width: 1280, height: 800 }, globals: {} },
  { name: 'mobile', viewport: { name: 'mobile', width: 375, height: 812 }, globals: {} },
];

/** Dependency and lockfile changes can affect any story but don't show up in the module graph. */
const DEFAULT_FULL_REBUILD_ON = [
  '**/package.json',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/.lookout.yml',
];

const DEFAULT_REVIEW: ReviewConfig = {
  default: [],
  rules: [],
  groups: {},
  minimum: 1,
  perRule: true,
  dismissOnNewChanges: true,
};

/**
 * Modes are the cross product of viewports and themes, so `viewports: [desktop, mobile]`
 * with `themes: [light, dark]` gives desktop-light, desktop-dark, mobile-light, mobile-dark.
 */
function buildModes(raw: any): Mode[] {
  if (!raw) return DEFAULT_MODES;
  const viewports = (raw.viewports ?? DEFAULT_MODES.map(m => m.viewport)).map((v: any) => ({
    name: String(v.name),
    width: Number(v.width),
    height: Number(v.height ?? 800),
  }));
  const themes: string[] = raw.themes ?? [];
  const themeGlobal: string = raw.themeGlobal ?? 'theme';
  if (themes.length === 0) {
    return viewports.map((viewport: Mode['viewport']) => ({ name: viewport.name, viewport, globals: {} }));
  }
  return viewports.flatMap((viewport: Mode['viewport']) =>
    themes.map(theme => ({ name: `${viewport.name}-${theme}`, viewport, globals: { [themeGlobal]: theme } })),
  );
}

export function normalizeConfig(raw: any, baseDir = process.cwd()): LookoutConfig {
  raw = raw ?? {};
  const review = { ...DEFAULT_REVIEW, ...(raw.reviewers ?? {}), ...(raw.approval ?? {}) };
  return {
    server: process.env.LOOKOUT_SERVER ?? raw.server ?? 'http://localhost:4400',
    baseBranch: raw.baseBranch ?? 'main',
    autoAcceptOnBaseBranch: raw.autoAcceptOnBaseBranch ?? true,
    projects: (raw.projects ?? []).map((p: any) => {
      const storybook = resolve(baseDir, String(p.storybook));
      return { name: String(p.name), storybook, root: p.root ? resolve(baseDir, String(p.root)) : dirname(storybook) };
    }),
    modes: buildModes(raw.modes),
    diffThreshold: raw.diffThreshold ?? 0.1,
    concurrency: raw.concurrency ?? 4,
    onlyChanged: {
      enabled: typeof raw.onlyChanged === 'object' ? (raw.onlyChanged.enabled ?? true) : raw.onlyChanged === true,
      fullRebuildOn: raw.onlyChanged?.fullRebuildOn ?? DEFAULT_FULL_REBUILD_ON,
    },
    review: {
      default: review.default ?? [],
      rules: review.rules ?? [],
      groups: review.groups ?? {},
      minimum: review.minimum,
      perRule: review.perRule,
      dismissOnNewChanges: review.dismissOnNewChanges,
    },
    bitbucket: raw.bitbucket
      ? {
          kind: raw.bitbucket.kind ?? 'cloud',
          workspace: raw.bitbucket.workspace,
          repo: raw.bitbucket.repo,
          baseUrl: raw.bitbucket.baseUrl,
          statuses: raw.bitbucket.statuses ?? ['visual', 'review'],
        }
      : undefined,
  };
}

export function loadConfig(path = '.lookout.yml'): LookoutConfig {
  const full = resolve(path);
  if (!existsSync(full)) return normalizeConfig({});
  return normalizeConfig(parse(readFileSync(full, 'utf8')), dirname(full));
}
