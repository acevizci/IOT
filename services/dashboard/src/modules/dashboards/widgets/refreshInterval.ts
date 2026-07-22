// Ortak yardımcı: WidgetSettingsModal'daki "Yenilenme süresi" seçiminden gelen
// config.refresh_interval_seconds'ı react-query'nin refetchInterval'ına çevirir.
// Kullanıcı hiç ayarlamamışsa (undefined/null) çağıranın kendi (tipe özel)
// varsayılanı kullanılır -- mevcut davranışta regresyon yok. 0 = "Yenileme yok"
// (react-query'de false = hiç otomatik poll etme).
export function resolveRefreshInterval(config: Record<string, any> | undefined, defaultMs: number): number | false {
  const seconds = config?.refresh_interval_seconds;
  if (seconds === undefined || seconds === null) return defaultMs;
  if (seconds <= 0) return false;
  return seconds * 1000;
}
