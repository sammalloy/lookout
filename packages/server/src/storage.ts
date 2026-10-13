import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Content-addressed image store on local disk. Swap this for an S3-backed version
 * when running for a team; the rest of the server only uses these four methods.
 */
export class Storage {
  private images: string;
  private diffs: string;

  constructor(dataDir: string) {
    this.images = join(dataDir, 'images');
    this.diffs = join(dataDir, 'diffs');
    mkdirSync(this.images, { recursive: true });
    mkdirSync(this.diffs, { recursive: true });
  }

  putImage(hash: string, png: Buffer) {
    const file = join(this.images, `${hash}.png`);
    if (!existsSync(file)) writeFileSync(file, png);
  }

  getImage(hash: string): Buffer | undefined {
    const file = join(this.images, `${hash.replace(/[^a-f0-9]/g, '')}.png`);
    return existsSync(file) ? readFileSync(file) : undefined;
  }

  putDiff(snapshotId: number, png: Buffer) {
    writeFileSync(join(this.diffs, `${snapshotId}.png`), png);
  }

  getDiff(snapshotId: number): Buffer | undefined {
    const file = join(this.diffs, `${snapshotId}.png`);
    return existsSync(file) ? readFileSync(file) : undefined;
  }
}
