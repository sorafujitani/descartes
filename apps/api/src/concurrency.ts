/** Limits concurrent tasks; a released slot passes directly to the oldest waiter. */
export function semaphore(limit: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Maps with at most `limit` tasks in flight, stopping new work after the first failure. */
export async function mapConcurrent<T, R>(
  limit: number,
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failure: unknown;
  async function work() {
    while (next < items.length && failure === undefined) {
      const index = next++;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        failure = error;
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(work());
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
  return results;
}
