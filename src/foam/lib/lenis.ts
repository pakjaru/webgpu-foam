// Lenis: smooth scrolling for the home route. The renderer's frame loop
// drives it (autoRaf off), so scroll and drawing advance in the same frame.
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

export type SmoothScroll = Lenis;

export const createSmoothScroll = (): SmoothScroll => new Lenis({ autoRaf: false });
