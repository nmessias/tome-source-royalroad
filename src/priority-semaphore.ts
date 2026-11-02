/** Limit browser pages while giving queued interactive requests precedence. */
export class PrioritySemaphore {
  private active = 0;
  private readonly foreground: Array<{ grant(): void }> = [];
  private readonly background: Array<{ grant(): void }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid browser concurrency limit");
  }

  acquire(background = false, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error("Browser request cancelled")); return; }
      const queue = background ? this.background : this.foreground;
      const waiter = { grant: () => {
        signal?.removeEventListener("abort", abort);
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.drain();
        });
      } };
      const abort = () => {
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(new Error("Browser request cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      queue.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit) {
      const waiter = this.foreground.shift() ?? this.background.shift();
      if (!waiter) break;
      waiter.grant();
    }
  }
}
