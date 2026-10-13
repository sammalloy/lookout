import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webp': 'image/webp',
};

/** Serve a static Storybook build on a free localhost port. */
export async function serveDir(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = join(dir, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}
