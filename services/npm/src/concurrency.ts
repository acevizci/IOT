// runWithConcurrencyLimit, ayrı bir dosyaya taşındı ki hem index.ts (normal metrik
// polling) hem lldpDiscovery.ts (LLDP keşfi) bunu import edebilsin -- lldpDiscovery.ts
// zaten index.ts tarafından import edildiği için, index.ts'ten import etmek döngüsel
// bir bağımlılık (circular import) yaratırdı.
export async function runWithConcurrencyLimit(items: any[], limit: number, worker: (item: any) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(workers);
}
