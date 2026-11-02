/** Return retained content only for failures explicitly classified as unreachable. */
export async function withStale<T>(
  live: () => Promise<T>,
  readStale: () => string | null,
  eligible: (error: unknown) => boolean,
  onStale?: (error: unknown) => void,
): Promise<T> {
  try {
    return await live();
  } catch (error) {
    const stale = eligible(error) ? readStale() : null;
    if (stale === null) throw error;
    onStale?.(error);
    return JSON.parse(stale) as T;
  }
}
