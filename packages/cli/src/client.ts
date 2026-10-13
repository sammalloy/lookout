import type { LookoutConfig } from '@lookout/core';
import type { Shot } from './capture.ts';

export class LookoutClient {
  private server: string;
  private token: string | undefined;

  constructor(server: string, token = process.env.LOOKOUT_TOKEN) {
    this.server = server;
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}) {
    return this.token ? { ...extra, Authorization: `Bearer ${this.token}` } : extra;
  }

  private async call<T>(method: string, path: string, body?: BodyInit, type = 'application/json'): Promise<T> {
    const res = await fetch(`${this.server}${path}`, { method, headers: this.headers({ 'Content-Type': type }), body });
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  createBuild(input: { project: string; branch: string; baseBranch?: string; commit: string; prId: string | null; config: LookoutConfig }) {
    return this.call<{ id: number; reviewKey: string; url: string }>('POST', '/api/builds', JSON.stringify(input));
  }

  uploadShot(buildId: number, shot: Shot) {
    const q = new URLSearchParams({
      storyId: shot.story.id,
      title: shot.story.title,
      name: shot.story.name,
      mode: shot.mode.name,
    });
    if (shot.error) q.set('error', shot.error);
    if (shot.diffThreshold !== undefined) q.set('diffThreshold', String(shot.diffThreshold));
    return this.call('PUT', `/api/builds/${buildId}/snapshots?${q}`, shot.png ? new Uint8Array(shot.png) : '', 'image/png');
  }

  finalize(buildId: number) {
    return this.call<{ counts: Record<string, number>; url: string }>('POST', `/api/builds/${buildId}/finalize`);
  }
}
