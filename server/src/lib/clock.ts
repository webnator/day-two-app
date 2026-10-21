export interface Clock {
  now(): number; // epoch ms
}

export const systemClock: Clock = { now: () => Date.now() };

/** Manually advanced clock for tests. */
export class FakeClock implements Clock {
  constructor(private t = Date.UTC(2026, 9, 5, 10, 0, 0)) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}
