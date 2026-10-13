import { matchGlob } from './glob.ts';
import type { ReviewConfig } from './types.ts';

export interface Requirement {
  /** The rule's glob, or "default". */
  rule: string;
  /** Anyone in this list can satisfy the requirement. */
  reviewers: string[];
  satisfiedBy?: string;
}

export interface ApprovalOutcome {
  approved: boolean;
  changesRequested: string[];
  requirements: Requirement[];
  approvals: string[];
  missing: number;
}

function expand(names: string[], groups: Record<string, string[]>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const key = name.replace(/^@/, '');
    if (groups[key]) groups[key].forEach(m => out.add(m.replace(/^@/, '')));
    else out.add(key);
  }
  return [...out];
}

/** Which reviewer groups a set of changed snapshot paths pulls in. */
export function requiredReviewers(config: ReviewConfig, changedPaths: string[]): Requirement[] {
  const reqs: Requirement[] = [];
  for (const rule of config.rules) {
    if (changedPaths.some(p => matchGlob(rule.match, p))) {
      reqs.push({ rule: rule.match, reviewers: expand(rule.reviewers, config.groups) });
    }
  }
  if (config.default.length > 0 && changedPaths.length > 0) {
    reqs.unshift({ rule: 'default', reviewers: expand(config.default, config.groups) });
  }
  return reqs;
}

export function evaluateApprovals(
  config: ReviewConfig,
  changedPaths: string[],
  verdicts: Array<{ user: string; verdict: 'approved' | 'changes_requested' }>,
): ApprovalOutcome {
  const approvals = verdicts.filter(v => v.verdict === 'approved').map(v => v.user);
  const changesRequested = verdicts.filter(v => v.verdict === 'changes_requested').map(v => v.user);
  const requirements = requiredReviewers(config, changedPaths).map(r => ({
    ...r,
    satisfiedBy: approvals.find(a => r.reviewers.includes(a)),
  }));
  if (changedPaths.length === 0) {
    return { approved: true, changesRequested: [], requirements: [], approvals, missing: 0 };
  }
  const unmetRules = config.perRule ? requirements.filter(r => !r.satisfiedBy).length : 0;
  const shortOfMinimum = Math.max(0, config.minimum - approvals.length);
  const missing = Math.max(unmetRules, shortOfMinimum);
  return {
    approved: missing === 0 && changesRequested.length === 0,
    changesRequested,
    requirements,
    approvals,
    missing,
  };
}
