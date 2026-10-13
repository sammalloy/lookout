import type { BitbucketConfig, CommitStatus } from '@lookout/core';

/**
 * Posts build statuses to Bitbucket. A branch restriction that requires passing builds
 * then blocks the merge until Lookout reports SUCCESSFUL.
 *
 * Auth, from the server's environment:
 *   BITBUCKET_TOKEN                      repository/workspace access token (Bearer)
 *   BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD   Cloud app password (Basic)
 *   BITBUCKET_API_URL                    override the API root (tests, proxies)
 */
export async function postStatus(config: BitbucketConfig, commit: string, status: CommitStatus): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.BITBUCKET_TOKEN) {
    headers.Authorization = `Bearer ${process.env.BITBUCKET_TOKEN}`;
  } else if (process.env.BITBUCKET_USERNAME && process.env.BITBUCKET_APP_PASSWORD) {
    const basic = Buffer.from(`${process.env.BITBUCKET_USERNAME}:${process.env.BITBUCKET_APP_PASSWORD}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }

  let url: string;
  if (config.kind === 'datacenter') {
    const root = process.env.BITBUCKET_API_URL ?? `${config.baseUrl}/rest/api/latest`;
    url = `${root}/projects/${config.workspace}/repos/${config.repo}/commits/${commit}/builds`;
  } else {
    const root = process.env.BITBUCKET_API_URL ?? 'https://api.bitbucket.org/2.0';
    url = `${root}/repositories/${config.workspace}/${config.repo}/commit/${commit}/statuses/build`;
  }

  const body = {
    key: status.key,
    state: status.state,
    name: status.name,
    url: status.url,
    description: status.description.slice(0, 255),
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`Bitbucket status ${status.key} failed: ${res.status} ${await res.text()}`);
  }
}
