import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes a minimal static "Storybook build": an index.json and an iframe.html that renders
 * stories by id and exposes __STORYBOOK_PREVIEW__.currentRender the way Storybook 7-9 does.
 */
export function writeFakeStorybook(dir: string, opts: { project: 'design-system' | 'checkout'; buttonColor: string }) {
  mkdirSync(dir, { recursive: true });
  const stories: Record<string, { title: string; name: string; html: string; parameters?: object }> =
    opts.project === 'design-system'
      ? {
          'components-button--primary': { title: 'Components/Button', name: 'Primary', html: `<button class="btn primary">Pay now</button>` },
          'components-button--secondary': { title: 'Components/Button', name: 'Secondary', html: `<button class="btn secondary">Cancel</button>` },
          'components-textfield--default': { title: 'Components/TextField', name: 'Default', html: `<label>Email <input value="sam@example.com"></label>` },
          'components-spinner--default': { title: 'Components/Spinner', name: 'Default', html: `<div>spinning</div>`, parameters: { lookout: { disable: true } } },
        }
      : {
          'checkout-summary--default': {
            title: 'Checkout/Summary',
            name: 'Default',
            html: `<h2>Order summary</h2><p>Total: £42.00</p><button class="btn primary">Pay now</button>`,
          },
          'checkout-address--default': {
            title: 'Checkout/Address',
            name: 'Default',
            html: `<h2>Address</h2><label>Street <input value="1 High St"></label>`,
          },
        };

  const index = {
    v: 5,
    entries: Object.fromEntries(
      Object.entries(stories).map(([id, s]) => [id, { id, title: s.title, name: s.name, type: 'story', importPath: './x.stories.tsx' }]),
    ),
  };
  index.entries['components-button--docs' as keyof typeof index.entries] = { id: 'components-button--docs', title: 'Components/Button', name: 'Docs', type: 'docs', importPath: './x.mdx' } as any;
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));

  writeFileSync(
    join(dir, 'iframe.html'),
    `<!doctype html><html><head><style>
      body { font-family: sans-serif; margin: 16px; }
      body.dark { background: #111; color: #eee; }
      .btn { padding: 8px 16px; border-radius: 6px; border: 0; font-size: 14px; }
      .primary { background: ${opts.buttonColor}; color: white; }
      .secondary { background: #ddd; }
    </style></head><body><div id="storybook-root"></div><script>
      const stories = ${JSON.stringify(stories)};
      const params = new URLSearchParams(location.search);
      const id = params.get('id');
      const globals = Object.fromEntries((params.get('globals') || '').split(';').filter(Boolean).map(p => p.split(':')));
      if (globals.theme === 'dark') document.body.classList.add('dark');
      const render = { id, phase: 'rendering', story: { id, parameters: (stories[id] || {}).parameters || {} } };
      window.__STORYBOOK_PREVIEW__ = { currentRender: render };
      setTimeout(() => {
        document.getElementById('storybook-root').innerHTML = stories[id] ? stories[id].html : 'missing';
        render.phase = stories[id] ? 'completed' : 'errored';
      }, 30);
    </script></body></html>`,
  );
}
