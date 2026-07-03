import { useEffect, useState } from "react";

/**
 * Seconds elapsed since `startedAt` (epoch ms), ticking every second while
 * `running` is true. Powers the settlement wait — the whole point is that
 * this number keeps moving so the wait never reads as a hung spinner.
 */
export function useElapsedSeconds(startedAt: number | null, running: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running || startedAt === null) return;
    setElapsed((Date.now() - startedAt) / 1000);
    const id = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
    return () => window.clearInterval(id);
  }, [startedAt, running]);

  return elapsed;
}
