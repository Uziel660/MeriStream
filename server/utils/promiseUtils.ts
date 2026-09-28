/** ES2019-compatible equivalent of Promise.any. */
export function firstFulfilled<T>(promises: Iterable<PromiseLike<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let pending = 0;
    let lastError: unknown = new Error("no_promises");
    for (const promise of promises) {
      pending += 1;
      Promise.resolve(promise).then(resolve, (error) => {
        lastError = error;
        pending -= 1;
        if (pending === 0) reject(lastError);
      });
    }
    if (pending === 0) reject(lastError);
  });
}
