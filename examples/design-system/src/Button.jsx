import React from 'react';

export function Button({ variant = 'primary', children, ...props }) {
  return <button className={`ds-button ds-button--${variant}`} {...props}>{children}</button>;
}
