import React from 'react';
import { Button } from './Button';

export default { title: 'Components/Card' };

export const WithActions = {
  render: () => (
    <div className="ds-card">
      <h3 style={{ marginTop: 0 }}>Order summary</h3>
      <p>Total: £42.00</p>
      <Button>Pay now</Button> <Button variant="secondary">Cancel</Button>
    </div>
  ),
};

export const Clock = {
  render: () => <div className="ds-card">Rendered at <span className="time">{new Date().toISOString()}</span></div>,
  parameters: { lookout: { ignoreSelectors: ['.time'] } },
};
