// Minimal concurrency limiter — same shape as p-limit but without the
// ESM-only dependency that breaks our esbuild CJS bundle (p-limit is
// type:"module" and esbuild externalizes it, so require('p-limit') fails
// at runtime with "X.default is not a function").
//
// Usage:
//   const limit = pLimit(5);
//   const result = await limit(() => someAsyncFn());
export function pLimit(concurrency: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    running--;
    const job = queue.shift();
    if (job) {
      running++;
      job();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(resolve, reject).finally(next);
      };
      if (running < concurrency) {
        running++;
        run();
      } else {
        queue.push(run);
      }
    });
}
