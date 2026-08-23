// A tiny semaphore to cap concurrent traecli processes.

export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.permits--;
    return () => this.release();
  }

  private release(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) next();
  }
}
