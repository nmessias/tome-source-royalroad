/** Share an in-flight operation without caching its result or failures. */
export class SingleFlight<K, V> {
  private readonly running = new Map<K, Promise<V>>();

  run(key: K, operation: () => Promise<V>): Promise<V> {
    const existing = this.running.get(key);
    if (existing) return existing;

    const promise = Promise.resolve().then(operation);
    this.running.set(key, promise);
    void promise.finally(() => {
      if (this.running.get(key) === promise) this.running.delete(key);
    }).catch(() => {});
    return promise;
  }
}
