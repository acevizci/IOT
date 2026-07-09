import { redisClient } from "./redisClient.js";

export interface PreprocessingStep {
  step_type: "change_per_second" | "multiplier" | "jsonpath" | "regex";
  params: Record<string, any>;
}

// Önceki ham değer + zaman damgasını Redis'te 1 saat TTL ile saklar (change_per_second için).
async function getPreviousRawValue(cacheKey: string): Promise<{ value: number; timestamp: number } | null> {
  const raw = await redisClient.get(cacheKey);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function setPreviousRawValue(cacheKey: string, value: number, timestamp: number): Promise<void> {
  await redisClient.set(cacheKey, JSON.stringify({ value, timestamp }), { EX: 3600 });
}

// Ham değeri, tanımlı preprocessing adımlarından sırayla geçirir.
// change_per_second: sayaç metriklerini (sürekli artan ham değer) saniye başına değişime çevirir —
// bu olmadan grafikler anlamsız olur ve eşik bazlı alarmlar yanlış tetiklenir (7.1 kritik bulgusu).
export async function applyPreprocessing(
  deviceId: string,
  metricName: string,
  rawValue: number,
  steps: PreprocessingStep[]
): Promise<number | null> {
  let value = rawValue;
  const now = Date.now();

  for (const step of steps) {
    if (step.step_type === "change_per_second") {
      const cacheKey = `preprocess:cps:${deviceId}:${metricName}`;
      const previous = await getPreviousRawValue(cacheKey);
      await setPreviousRawValue(cacheKey, rawValue, now);

      if (!previous) {
        // İlk ölçüm — henüz bir "önceki" değer yok, bu turu atla (rate hesaplanamaz)
        return null;
      }

      const elapsedSeconds = (now - previous.timestamp) / 1000;
      if (elapsedSeconds <= 0) return null;

      let delta = rawValue - previous.value;
      // Sayaç taşması (counter wrap/reset) korunumu — negatif delta'yı reddet
      if (delta < 0) return null;

      value = delta / elapsedSeconds;
    } else if (step.step_type === "multiplier") {
      const factor = Number(step.params?.factor ?? 1);
      value = value * factor;
    }
    // jsonpath/regex adımları ham STRING yanıt üzerinde çalışır, bu fonksiyon sayısal
    // değer aldığı için burada uygulanmaz — HTTP/JSON collector'da yanıt seviyesinde işlenir.
  }

  return value;
}
