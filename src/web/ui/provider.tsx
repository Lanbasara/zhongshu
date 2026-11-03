import type { ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { Tooltip } from 'radix-ui';
export function UIProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user"><Tooltip.Provider delayDuration={450}>{children}</Tooltip.Provider></MotionConfig>;
}
