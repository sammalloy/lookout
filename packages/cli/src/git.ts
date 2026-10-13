import { execFileSync } from 'node:child_process';

export interface GitInfo {
  branch: string;
  commit: string;
  prId: string | null;
  baseBranch?: string;
}

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Bitbucket Pipelines variables first, then local git. */
export function detectGit(): GitInfo {
  const env = process.env;
  return {
    branch: env.BITBUCKET_BRANCH || git('rev-parse', '--abbrev-ref', 'HEAD') || 'unknown',
    commit: env.BITBUCKET_COMMIT || git('rev-parse', 'HEAD') || 'unknown',
    prId: env.BITBUCKET_PR_ID || null,
    baseBranch: env.BITBUCKET_PR_DESTINATION_BRANCH || undefined,
  };
}

export function repoRoot(): string | null {
  return git('rev-parse', '--show-toplevel') || null;
}

/**
 * Files changed between `base` and the working tree (committed, staged, unstaged and
 * untracked), relative to the repo root. Returns null if `base` isn't in local history,
 * e.g. in a shallow CI clone.
 */
export function changedFilesSince(base: string): string[] | null {
  try {
    execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const diff = git('diff', '--name-only', base);
  const untracked = git('ls-files', '--others', '--exclude-standard', '--full-name', ':/');
  return [...new Set([...diff.split('\n'), ...untracked.split('\n')].filter(Boolean))];
}
