import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, type Lookout } from './service.ts';
import type { Storage } from './storage.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

type Handler = (req: IncomingMessage, params: Record<string, string>, url: URL) => Promise<unknown> | unknown;

async function readBody(req: IncomingMessage, limit = 50 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req, 5 * 1024 * 1024);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function requireUser(body: any): string {
  const user = String(body?.user ?? '').trim();
  if (!user) throw new HttpError(400, 'user is required');
  return user;
}

export function createApp(lookout: Lookout, storage: Storage, opts: { token?: string } = {}) {
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler; write?: boolean }> = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
    );
    routes.push({ method, pattern, keys, handler });
  };

  // CI upload API. Protected by LOOKOUT_TOKEN when it is set.
  route('POST', '/api/builds', async req => {
    const b = await json(req);
    for (const field of ['project', 'branch', 'commit', 'config']) {
      if (!b[field]) throw new HttpError(400, `${field} is required`);
    }
    const build = lookout.createBuild({
      project: b.project,
      branch: b.branch,
      baseBranch: b.baseBranch,
      commit: b.commit,
      prId: b.prId ? String(b.prId) : null,
      storybookUrl: b.storybookUrl,
      config: b.config,
    });
    await lookout.publishStatuses(build.review_key);
    return { id: build.id, reviewKey: build.review_key, url: lookout.reviewUrl(build.review_key) };
  });

  route('PUT', '/api/builds/:id/snapshots', async (req, p, url) => {
    const q = url.searchParams;
    const meta = {
      storyId: q.get('storyId') ?? '',
      title: q.get('title') ?? '',
      name: q.get('name') ?? '',
      mode: q.get('mode') ?? '',
      error: q.get('error') ?? undefined,
      diffThreshold: q.has('diffThreshold') ? Number(q.get('diffThreshold')) : undefined,
    };
    if (!meta.storyId || !meta.mode) throw new HttpError(400, 'storyId and mode are required');
    const body = await readBody(req);
    lookout.addSnapshot(Number(p.id), meta, meta.error ? undefined : body);
    return { ok: true };
  });

  route('POST', '/api/builds/:id/finalize', async (_req, p) => lookout.finalize(Number(p.id)));

  // Review app API.
  route('GET', '/api/reviews', () => lookout.listReviews());
  route('GET', '/api/reviews/:key', (_req, p) => lookout.review(decodeURIComponent(p.key)));

  route('POST', '/api/reviews/:key/verdict', async (req, p) => {
    const b = await json(req);
    const key = decodeURIComponent(p.key);
    if (!['approved', 'changes_requested'].includes(b.verdict)) throw new HttpError(400, 'verdict must be approved or changes_requested');
    lookout.verdict(key, requireUser(b), b.verdict);
    await lookout.publishStatuses(key);
    return lookout.review(key);
  });

  route('POST', '/api/reviews/:key/comments', async (req, p) => {
    const b = await json(req);
    const key = decodeURIComponent(p.key);
    if (!b.body) throw new HttpError(400, 'body is required');
    lookout.addComment(key, { ...b, user: requireUser(b) });
    return lookout.review(key);
  });

  route('POST', '/api/snapshots/:id/:decision', async (req, p) => {
    const map: Record<string, 'accepted' | 'denied' | 'reset'> = { accept: 'accepted', deny: 'denied', reset: 'reset' };
    const decision = map[p.decision];
    if (!decision) throw new HttpError(404, 'not found');
    const b = await json(req);
    const ids: number[] = p.id === 'batch' ? (b.ids ?? []).map(Number) : [Number(p.id)];
    let key = '';
    for (const id of ids) key = lookout.decide(id, decision, requireUser(b));
    if (key) await lookout.publishStatuses(key);
    return key ? lookout.review(key) : { ok: true };
  });

  // Bitbucket webhook: on merge, promote the PR branch's accepted baselines.
  route('POST', '/api/webhooks/bitbucket', async req => {
    const event = String(req.headers['x-event-key'] ?? '');
    const b = await json(req);
    if (event === 'pullrequest:fulfilled' || event === 'pr:merged') {
      const pr = b.pullrequest ?? b.pullRequest;
      const from = pr?.source?.branch?.name ?? pr?.fromRef?.displayId;
      const to = pr?.destination?.branch?.name ?? pr?.toRef?.displayId;
      if (from && to) return { promoted: lookout.promoteBranch(undefined, from, to) };
    }
    return { ignored: event };
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname.startsWith('/images/')) {
        return sendPng(res, storage.getImage(url.pathname.slice(8).replace(/\.png$/, '')));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/diffs/')) {
        return sendPng(res, storage.getDiff(Number(url.pathname.slice(7).replace(/\.png$/, ''))));
      }
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.pattern);
        if (!m) continue;
        if (opts.token && url.pathname.startsWith('/api/builds') && req.headers.authorization !== `Bearer ${opts.token}`) {
          throw new HttpError(401, 'missing or wrong LOOKOUT_TOKEN');
        }
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = m[i + 1]));
        const result = await r.handler(req, params, url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      if (req.method === 'GET') return sendStatic(res, url.pathname);
      throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  return server;
}

function sendPng(res: ServerResponse, buf: Buffer | undefined) {
  if (!buf) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.end(buf);
}

function sendStatic(res: ServerResponse, pathname: string) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) file = join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}
