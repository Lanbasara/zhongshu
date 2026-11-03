import { timing } from './tokens.ts';
export const transitions = {
  state: { duration: timing.state / 1000, ease: [...timing.ease] as [number, number, number, number] },
  surface: { duration: timing.surface / 1000, ease: [...timing.ease] as [number, number, number, number] },
};
