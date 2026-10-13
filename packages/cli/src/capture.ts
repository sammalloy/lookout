import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import type { LookoutConfig, Mode, StoryOptions } from '@lookout/core';
import { serveDir } from './static-server.ts';

export interface StoryEntry {
  id: string;
  title: string;
  name: string;
}

export interface Shot {
  story: StoryEntry;
  mode: Mode;
  png?: Buffer;
  error?: string;
  diffThreshold?: number;
  skipped?: boolean;
}

export function readStoryIndex(storybookDir: string): StoryEntry[] {
  const indexFile = [join(storybookDir, 'index.json'), join(storybookDir, 'stories.json')].find(existsSync);
  if (!indexFile) {
    throw new Error(`No index.json in ${storybookDir}. Run \`storybook build\` first and point "storybook" at its output.`);
  }
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  const entries = Object.values(index.entries ?? index.stories ?? {}) as any[];
  return entries
    .filter(e => (e.type ?? 'story') === 'story')
    .map(e => ({ id: e.id, title: e.title, name: e.name }));
}

function storyUrl(base: string, storyId: string, mode: Mode): string {
  const globals = Object.entries(mode.globals).map(([k, v]) => `${k}:${v}`).join(';');
  return `${base}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story${globals ? `&globals=${encodeURIComponent(globals)}` : ''}`;
}

/**
 * Wait until Storybook reports the story rendered (and its play function finished),
 * then return the story's `parameters.lookout`.
 */
async function waitForStory(page: Page, storyId: string, timeout: number): Promise<StoryOptions> {
  await page.waitForFunction(
    id => {
      const preview = (window as any).__STORYBOOK_PREVIEW__;
      const render = preview?.currentRender;
      if (render) {
        const sameStory = !render.id || render.id === id || render.story?.id === id;
        return sameStory && ['played', 'completed', 'finished', 'errored', 'aborted'].includes(render.phase);
      }
      const root = document.querySelector('#storybook-root, #root');
      return !preview && !!root && root.childElementCount > 0;
    },
    storyId,
    { timeout, polling: 50 },
  );
  const result = await page.evaluate(() => {
    const render = (window as any).__STORYBOOK_PREVIEW__?.currentRender;
    const errorShown = document.body.classList.contains('sb-show-errordisplay');
    return {
      options: (render?.story?.parameters?.lookout ?? {}) as StoryOptions,
      error: render?.phase === 'errored' || errorShown
        ? document.querySelector('#error-message')?.textContent || 'Story failed to render'
        : null,
    };
  });
  if (result.error) throw new Error(result.error);
  await page.evaluate(() => document.fonts.ready);
  return result.options;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function captureOne(page: Page, base: string, story: StoryEntry, mode: Mode): Promise<Shot> {
  await page.setViewportSize({ width: mode.viewport.width, height: mode.viewport.height });
  await page.goto(storyUrl(base, story.id, mode), { waitUntil: 'load' });
  const options = await waitForStory(page, story.id, 20_000);
  if (options.disable || (options.modes && !options.modes.includes(mode.name))) {
    return { story, mode, skipped: true };
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  if (options.delay) await page.waitForTimeout(options.delay);

  const mask = (options.ignoreSelectors ?? []).map(sel => page.locator(sel));
  const shotOptions = { animations: 'disabled', caret: 'hide', mask, scale: 'css' } as const;
  // Crop to the rendered story like Chromatic does; `capture: 'page'` keeps the whole viewport.
  const root = page.locator('#storybook-root, #root').first();
  const box = options.capture === 'page' ? null : await root.boundingBox().catch(() => null);
  const shoot = () =>
    box && box.width > 0 && box.height > 0
      ? root.screenshot(shotOptions)
      : page.screenshot({ ...shotOptions, fullPage: true });

  // Retake until two consecutive shots agree, so half-loaded images or late layout don't become diffs.
  let prev = await shoot();
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(150);
    const next = await shoot();
    if (sha(next) === sha(prev)) return { story, mode, png: next, diffThreshold: options.diffThreshold };
    prev = next;
  }
  return { story, mode, png: prev, diffThreshold: options.diffThreshold };
}

export interface CaptureOptions {
  storybookDir: string;
  config: LookoutConfig;
  onShot: (shot: Shot) => Promise<void>;
  filter?: (story: StoryEntry) => boolean;
}

export async function captureStorybook({ storybookDir, config, onShot, filter }: CaptureOptions) {
  const stories = readStoryIndex(storybookDir).filter(s => !filter || filter(s));
  const { url, server } = await serveDir(storybookDir);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.LOOKOUT_CHROMIUM_PATH || undefined });
    const tasks = stories.flatMap(story => config.modes.map(mode => ({ story, mode })));
    let next = 0;
    const counts = { captured: 0, skipped: 0, errors: 0 };
    const worker = async () => {
      const context = await browser!.newContext({ deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light' });
      const page = await context.newPage();
      while (next < tasks.length) {
        const { story, mode } = tasks[next++];
        let shot: Shot;
        try {
          shot = await captureOne(page, url, story, mode);
        } catch (err) {
          shot = { story, mode, error: (err as Error).message.split('\n')[0] };
        }
        if (shot.skipped) counts.skipped++;
        else if (shot.error) counts.errors++;
        else counts.captured++;
        if (!shot.skipped) await onShot(shot);
      }
      await context.close();
    };
    await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, worker));
    return { stories: stories.length, ...counts };
  } finally {
    await browser?.close();
    server.close();
  }
}
