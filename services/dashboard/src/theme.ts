/**
 * Gözlem — Tema (JS renk kaynağı)
 *
 * DOM/Tailwind renkleri `src/index.css`'teki CSS değişkenlerinden gelir.
 * Ama grafik/SVG kütüphaneleri (recharts, topoloji SVG'si) renkleri
 * JS değeri olarak ister — onların TEK kaynağı bu dosyadır.
 *
 * Değerler index.css'teki "Kömür & Adaçayı" paletiyle birebir aynıdır;
 * paleti değiştirdiğinde bu dosyayı da güncelle (grafik renkleri için).
 */

/** Marka ve durum renkleri — index.css semantik rolleriyle eş. */
export const COLORS = {
  brand: "#78a891",
  success: "#8fbfa6",
  warning: "#d9b77a",
  danger: "#d08a78",
  info: "#7fa0ae",
  neutral: "#9a9d98",
} as const;

/**
 * Severity (Zabbix tarzı önem dereceleri) — soğuk bilgi → sıcak felaket
 * yönünde, tema toprak ailesinden türetilmiş sıralı yoğunluk.
 */
export const SEVERITY_COLORS: Record<string, string> = {
  info: "#7fa0ae",      /* slate */
  warning: "#d9b77a",   /* ochre */
  average: "#ce9a6a",   /* amber-kil */
  high: "#c97b6a",      /* kil */
  disaster: "#a6483a",  /* koyu kil */
};

export const SEVERITY_LABELS: Record<string, string> = {
  info: "Bilgi", warning: "Uyarı", average: "Orta", high: "Yüksek", disaster: "Felaket",
};

/**
 * Grafik kategorik paleti — çoklu-metrik/çoklu-seri çizimlerde döngüsel.
 * Birbirinden ayrışan ama temayla uyumlu 8 ton.
 */
export const CHART_PALETTE = [
  "#78a891", /* adaçayı */
  "#d9b77a", /* ochre */
  "#7fa0ae", /* slate */
  "#c97b6a", /* kil */
  "#a9cdbb", /* açık adaçayı */
  "#b98ba6", /* mor-toprak */
  "#c79a4e", /* koyu ochre */
  "#6e9b96", /* teal-adaçayı */
] as const;

/** Durum ızgarası / cihaz durumu blokları için bg (yarı saydam) + metin. */
export const STATUS_TONES = {
  good:    { bg: "rgba(120,168,145,0.16)", text: "#8fbfa6" },
  warn:    { bg: "rgba(217,183,122,0.16)", text: "#d9b77a" },
  crit:    { bg: "rgba(201,123,106,0.18)", text: "#d08a78" },
  unknown: { bg: "rgba(154,157,152,0.14)", text: "#9a9d98" },
} as const;

/** İstersen bir CSS değişkenini çalışma anında okumak için. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
