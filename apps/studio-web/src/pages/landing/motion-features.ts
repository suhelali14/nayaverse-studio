import { domAnimation } from 'motion/react';

// Its own module so it becomes its own chunk, fetched by LazyMotion after
// the page has rendered. Transforms, opacity and exit animations; no drag
// or layout animation is used, so `domMax` would be weight for nothing.
export default domAnimation;
