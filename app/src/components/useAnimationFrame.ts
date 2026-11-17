import { useEffect, useRef } from 'react';

/** Calls fn every animation frame while mounted (fn may change between renders). */
export function useAnimationFrame(fn: (now: number) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let id = 0;
    const loop = (now: number) => {
      ref.current(now);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}
