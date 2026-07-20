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
  brand: "#3fb88a",
  success: "#5ecca3",
  warning: "#e0a935",
  danger: "#ea6b53",
  info: "#4a95c4",
  neutral: "#9a9d98",
} as const;

/**
 * Severity (Zabbix tarzı önem dereceleri) — soğuk bilgi → sıcak felaket
 * yönünde, tema toprak ailesinden türetilmiş sıralı yoğunluk (daha canlı/doygun).
 */
export const SEVERITY_COLORS: Record<string, string> = {
  info: "#4a95c4",      /* slate (canlı mavi) */
  warning: "#e0a935",   /* ochre (canlı altın) */
  average: "#e8823f",   /* turuncu */
  high: "#ea6b53",      /* kil (canlı mercan-kırmızı) */
  disaster: "#b91c3c",  /* koyu, doygun kırmızı */
};

/**
 * Metin olarak kullanılacak severity renkleri. Dolgu (SEVERITY_COLORS)
 * koyu/doygun tonlar içerir; bunlar koyu zeminde METİN olarak okunmaz
 * (özellikle disaster). Metin için AA'yı geçen tonlar:
 */
export const SEVERITY_TEXT_COLORS: Record<string, string> = {
  info: "#4a95c4",
  warning: "#e0a935",
  average: "#e8823f",
  high: "#ea6b53",
  disaster: "#ef5a6a", /* dolgudaki #b91c3c metinde 2.4:1 -> okunmaz; bu ton 4.6:1 */
};

export const SEVERITY_LABELS: Record<string, string> = {
  info: "Bilgi", warning: "Uyarı", average: "Orta", high: "Yüksek", disaster: "Felaket",
};

/**
 * Grafik kategorik paleti — çoklu-metrik/çoklu-seri çizimlerde döngüsel.
 * Birbirinden ayrışan ama temayla uyumlu 8 ton (daha canlı/doygun).
 */
export const CHART_PALETTE = [
  // İlk 5 maksimum ayrışacak şekilde (yeşil, altın, mavi, mercan, mor);
  // birbirine yakın varyantlar (teal, açık yeşil, koyu ochre) sona.
  "#3fb88a", /* adaçayı */
  "#e0a935", /* ochre */
  "#4a95c4", /* slate */
  "#ea6b53", /* kil */
  "#c7699c", /* mor-toprak */
  "#2f9b8f", /* teal-adaçayı */
  "#82dbb8", /* açık adaçayı */
  "#c98f1f", /* koyu ochre */
] as const;

/** Durum ızgarası / cihaz durumu blokları için bg (yarı saydam) + metin. */
export const STATUS_TONES = {
  good:    { bg: "rgba(94,204,163,0.18)", text: "#5ecca3" },
  warn:    { bg: "rgba(224,169,53,0.18)", text: "#e0a935" },
  crit:    { bg: "rgba(224,80,58,0.22)",  text: "#ea6b53" },
  unknown: { bg: "rgba(154,157,152,0.14)", text: "#9a9d98" },
} as const;

/** İstersen bir CSS değişkenini çalışma anında okumak için. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
