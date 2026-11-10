import { MemorySink, Tracer, type TracerOptions } from "../src/index";

// A tracer with a fake clock and predictable IDs, so tests can assert exact values.
export function makeTracer(options: Partial<TracerOptions> = {}) {
  let time = 1_000;
  let nextId = 0;
  const sink = new MemorySink();
  const tracer = new Tracer({
    traceId: "trace-1",
    sink,
    now: () => time,
    newId: () => `span-${String(++nextId)}`,
    ...options,
  });
  const advance = (ms: number) => {
    time += ms;
  };
  return { tracer, sink, advance };
}
