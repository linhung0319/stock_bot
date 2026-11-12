/** 一次最多同時 n 個（Cloudflare 一次執行最多同時 6 條對外連線）。 */
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** 失敗時再試（預設再試 1 次）。 */
export async function retry<T>(fn: () => Promise<T>, times = 1): Promise<T> {
  for (let k = 0; ; k++) {
    try {
      return await fn();
    } catch (e) {
      if (k >= times) throw e;
    }
  }
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
