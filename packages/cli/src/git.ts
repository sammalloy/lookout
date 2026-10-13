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
