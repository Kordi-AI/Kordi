import { useSyncExternalStore } from 'react';
import type { HelpGroundingScreen } from './helpNavigation';

export type TourLocation = { target: string; groundingScreen?: HelpGroundingScreen };
let location: TourLocation | null = null;
const listeners = new Set<() => void>();
export function setHelpTourLocation(next: TourLocation | null) {
  location = next;
  listeners.forEach((listener) => listener());
}
export const getHelpTourLocation = () => location;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useHelpTourLocation() {
  return useSyncExternalStore(subscribe, () => location, () => null);
}
