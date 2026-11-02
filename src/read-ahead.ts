interface Job { user: string; fiction: string; chapter: number }
interface ReadAheadOptions {
  cached(chapter: number): boolean;
  fetch(chapter: number): Promise<unknown>;
  schedule?(callback: () => void, delay: number): void;
  now?(): number;
}

/** A bounded, serial queue for anonymous chapter content. */
export class ReadAheadQueue {
  private readonly active = new Map<string, string>();
  private pending: Job[] = [];
  private running = false;
  private scheduled = false;
  private backoffUntil = 0;
  private readonly schedule: (callback: () => void, delay: number) => void;
  private readonly now: () => number;

  constructor(private readonly options: ReadAheadOptions) {
    this.schedule = options.schedule ?? ((callback, delay) => { setTimeout(callback, delay); });
    this.now = options.now ?? Date.now;
  }

  enqueue(user: string, fiction: string, chapters: number[], depth: number): void {
    this.active.set(user, fiction);
    this.pending = this.pending.filter((job) => job.user !== user);
    const limit = Number.isFinite(depth) ? Math.max(0, Math.min(10, Math.floor(depth))) : 0;
    const unique = new Set<number>();
    for (const chapter of chapters.slice(0, limit)) {
      if (!Number.isInteger(chapter) || chapter <= 0 || unique.has(chapter) || this.options.cached(chapter)) continue;
      unique.add(chapter);
      this.pending.push({ user, fiction, chapter });
    }
    // Recent activity wins when several readers fill the queue.
    this.pending = this.pending.slice(-20);
    this.kick();
  }

  private kick(): void {
    if (this.running || this.scheduled || this.pending.length === 0) return;
    this.scheduled = true;
    const delay = Math.max(3000, this.backoffUntil - this.now());
    this.schedule(() => { this.scheduled = false; void this.runOne(); }, delay);
  }

  private async runOne(): Promise<void> {
    if (this.running) return;
    const job = this.pending.shift();
    if (!job) return;
    if (this.active.get(job.user) !== job.fiction || this.options.cached(job.chapter)) {
      this.kick();
      return;
    }
    this.running = true;
    try {
      await this.options.fetch(job.chapter);
    } catch (error) {
      console.warn("[ReadAhead] Pausing after a failed chapter fetch:", (error as Error).message);
      this.pending = [];
      this.backoffUntil = this.now() + 120_000;
    } finally {
      this.running = false;
      this.kick();
    }
  }
}
