import * as p from "@clack/prompts";

/** Progress output seam: clack spinner when interactive, plain lines otherwise. */
export interface Reporter {
  info(msg: string): void;
  start(msg: string): void;
  update(msg: string): void;
  stop(msg: string): void;
  done(msg: string): void;
}

export const plainReporter: Reporter = {
  info: (m) => console.log(m),
  start: (m) => console.log(`${m} ...`),
  update: () => {},
  stop: (m) => console.log(m),
  done: (m) => console.log(m),
};

/** clack-backed Reporter with an elapsed-seconds spinner. */
export function createClackReporter(): Reporter {
  let spin: ReturnType<typeof p.spinner> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let base = "";
  let startedAt = 0;
  const tick = () => {
    if (spin) spin.message(`${base} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  };
  return {
    info: (m) => p.log.info(m),
    start: (m) => {
      base = m;
      startedAt = Date.now();
      spin = p.spinner();
      spin.start(m);
      timer = setInterval(tick, 1000);
    },
    update: (m) => {
      base = m;
      tick();
    },
    stop: (m) => {
      if (timer) clearInterval(timer);
      timer = null;
      spin?.stop(m);
      spin = null;
    },
    done: (m) => p.outro(m),
  };
}
