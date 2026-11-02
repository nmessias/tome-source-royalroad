/** Runs `onIdle` once nothing has held a lease for `idleMs`. 0 disables it. */
export class IdleLease {
  private held = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly idleMs: number, private readonly onIdle: () => void) {}

  acquire(): () => void {
    this.held++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.held === 0 && this.idleMs > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.held === 0) this.onIdle();
        }, this.idleMs);
      }
    };
  }
}
