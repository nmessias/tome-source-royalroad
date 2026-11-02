/**
 * Offline reading: stop waiting on Royal Road once it cannot be reached (the
 * exit-node phone is off or away), and save chapters ahead of time so they
 * can still be read then.
 */

const PROBE_MS = 60_000;
let offlineSince = 0;
let probeTimer: ReturnType<typeof setInterval> | null = null;
const backOnline: Array<() => void> = [];

export function isOffline(): boolean {
  return offlineSince > 0;
}

/** Fail at once while offline instead of waiting out a 60s timeout per request. */
export function assertOnline(url: string): void {
  if (!offlineSince) return;
  // Named so isUnreachable() accepts it and stale copies are served.
  const error = new Error(`Royal Road unreachable since ${new Date(offlineSince).toISOString()}; skipped ${url}`);
  error.name = "NetworkError";
  throw error;
}

/** A transport error: go offline and probe until `probe` resolves again. */
export function noteUnreachable(probe: () => Promise<unknown>): void {
  if (offlineSince) return;
  offlineSince = Date.now();
  console.warn("[Offline] Royal Road unreachable; serving saved copies until it answers again");
  probeTimer = setInterval(() => {
    probe().then(() => {
      if (!offlineSince) return;
      console.log(`[Offline] Royal Road reachable again after ${Math.round((Date.now() - offlineSince) / 1000)}s`);
      markOnline();
      for (const callback of backOnline) {
        try { callback(); } catch (error) { console.error("[Offline] back-online callback failed:", error); }
      }
    }, () => {});
  }, PROBE_MS);
}

export function markOnline(): void {
  offlineSince = 0;
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = null;
}

export function onBackOnline(callback: () => void): void {
  backOnline.push(callback);
}

/** Chapter ids in a Royal Road RSS feed (/fiction/syndication/<id>), oldest first. */
export function parseSyndicationChapterIds(xml: string): number[] {
  const ids = new Set<number>();
  for (const m of xml.matchAll(/<link>[^<]*\/chapter\/(\d+)/g)) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => a - b);
}

/** The first chapter not yet read: after the last read one, else the resume point, else the start. */
export function unreadFrom(chapters: { id: number; isRead?: boolean }[], continueChapterId?: number): number {
  for (let i = chapters.length - 1; i >= 0; i--) if (chapters[i].isRead) return i + 1;
  const resume = chapters.findIndex((c) => c.id === continueChapterId);
  return resume >= 0 ? resume : 0;
}

interface SaveJob { fiction: number; chapter: number; tries: number }
interface SaveQueueOptions {
  cached(chapter: number): boolean;
  fetch(chapter: number): Promise<unknown>;
  offline(): boolean;
  paceMs: number;
  schedule?(callback: () => void, delay: number): void;
}

/**
 * One chapter at a time, `paceMs` apart: a 500-chapter save must look like a
 * slow reader, not a burst. Waits out offline spells without using up a
 * chapter's retries.
 */
export class SaveQueue {
  private jobs: SaveJob[] = [];
  private current: SaveJob | null = null;
  private busy = false;
  private readonly schedule: (callback: () => void, delay: number) => void;

  constructor(private readonly options: SaveQueueOptions) {
    this.schedule = options.schedule ?? ((callback, delay) => { setTimeout(callback, delay); });
  }

  /** Queue the chapters not already saved or queued; returns how many were added. */
  add(fiction: number, chapters: number[]): number {
    const queued = new Set(this.jobs.map((job) => job.chapter));
    if (this.current) queued.add(this.current.chapter);
    let added = 0;
    for (const chapter of chapters) {
      if (queued.has(chapter) || this.options.cached(chapter)) continue;
      queued.add(chapter);
      this.jobs.push({ fiction, chapter, tries: 0 });
      added++;
    }
    this.kick(0);
    return added;
  }

  pending(fiction: number): number {
    return this.jobs.filter((job) => job.fiction === fiction).length + (this.current?.fiction === fiction ? 1 : 0);
  }

  private kick(delay: number): void {
    if (this.busy || this.jobs.length === 0) return;
    this.busy = true;
    this.schedule(() => void this.runOne(), delay);
  }

  private async runOne(): Promise<void> {
    let delay = 0;
    if (this.options.offline()) {
      delay = PROBE_MS;
    } else {
      const job = this.jobs.shift()!;
      if (!this.options.cached(job.chapter)) {
        this.current = job;
        try {
          await this.options.fetch(job.chapter);
          delay = this.options.paceMs;
        } catch (error) {
          // ponytail: fixed 2-minute retry; back off further if Cloudflare keeps challenging.
          const offline = this.options.offline();
          if (offline || ++job.tries < 3) this.jobs.unshift(job);
          else console.warn(`[Offline] Giving up on chapter ${job.chapter}:`, (error as Error).message);
          delay = offline ? PROBE_MS : 120_000;
        } finally {
          this.current = null;
        }
      }
    }
    this.busy = false;
    this.kick(delay);
  }
}
