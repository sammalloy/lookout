import { Button } from './Button';

export default { title: 'Components/Button', component: Button };

export const Primary = { args: { children: 'Pay now' } };
export const Secondary = { args: { variant: 'secondary', children: 'Cancel' } };
export const MobileOnly = {
  args: { children: 'Only captured on mobile' },
  parameters: { lookout: { modes: ['mobile-light', 'mobile-dark'] } },
};
