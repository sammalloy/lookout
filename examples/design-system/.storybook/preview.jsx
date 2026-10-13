import React from 'react';
import '../src/tokens.css';

/** @type {import('@storybook/react-vite').Preview} */
export default {
  // Lookout passes ?globals=theme:dark for the dark modes in .lookout.yml.
  globalTypes: { theme: { description: 'Theme', defaultValue: 'light' } },
  initialGlobals: { theme: 'light' },
  decorators: [
    (Story, { globals }) => (
      <div data-theme={globals.theme} className="ds-root">
        <Story />
      </div>
    ),
  ],
};
