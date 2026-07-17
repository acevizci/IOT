import type { Pool } from "pg";

// Cok-metrikli ifade AST'sinin node tipleri (import_zabbix_templates.py'deki Python
// parser'ın urettigi JSON ile birebir aynı sekil).
type AstNode =
  | { type: "logical"; op: "and" | "or"; children: AstNode[] }
  | { type: "comparison"; op: "gt" | "lt" | "eq" | "gte" | "lte" | "ne"; left: AstNode; right: AstNode }
  | { type: "arithmetic"; op: "add" | "sub" | "mul" | "div"; left: AstNode; right: AstNode }
  | { type: "function"; fn: "last" | "min" | "max" | "avg"; metric_name: string; duration_seconds?: number }
  | { type: "literal"; value: number }
  | { type: "macro"; key: string };

// Bir fonksiyon operandının (last/min/max/avg) gerçek degerini, o cihaz+metrik icin
// verilen pencere (duration_seconds, yoksa sadece en son deger) uzerinden hesaplar.
// Yetersiz veri varsa null doner -- cagiran taraf bunu "bu dongude degerlendirilemez"
// olarak yorumlamali (false-positive/negative alarm riskini onlemek icin).
async function evaluateFunction(pool: Pool, tenantId: string, deviceId: string, node: Extract<AstNode, { type: "function" }>): Promise<number | null> {
  const durationSeconds = node.duration_seconds || 60;
  const result = await pool.query(
    `SELECT value FROM metrics WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
       AND time >= now() - ($4 || ' seconds')::interval
     ORDER BY time ASC`,
    [tenantId, deviceId, node.metric_name, durationSeconds]
  );
  const values: number[] = result.rows.map((r) => Number(r.value));
  if (values.length === 0) return null;

  switch (node.fn) {
    case "last": return values[values.length - 1];
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

// {$MAKRO} referanslarini cihazin gercek makro degerine cozer -- mevcut resolveNumericMacro
// ile ayni mantik, expression icindeki iceli makro node'lari icin kullanilir.
async function evaluateMacro(pool: Pool, tenantId: string, deviceId: string, key: string): Promise<number | null> {
  const result = await pool.query(
    `SELECT resolve_macro_value($1, $2, $3) as value`,
    [key, tenantId, deviceId]
  ).catch(() => null);
  if (result && result.rows.length > 0 && result.rows[0].value !== null) {
    const num = Number(result.rows[0].value);
    if (!Number.isNaN(num)) return num;
  }
  return null;
}

// AST'yi recursive olarak sayisal bir degere indirger (function/literal/macro/arithmetic
// dugumleri icin). Herhangi bir alt-dugum null donerse (yetersiz veri), tum zincir null olur.
async function evaluateNumeric(pool: Pool, tenantId: string, deviceId: string, node: AstNode): Promise<number | null> {
  switch (node.type) {
    case "function":
      return evaluateFunction(pool, tenantId, deviceId, node);
    case "literal":
      return node.value;
    case "macro":
      return evaluateMacro(pool, tenantId, deviceId, node.key);
    case "arithmetic": {
      const left = await evaluateNumeric(pool, tenantId, deviceId, node.left);
      const right = await evaluateNumeric(pool, tenantId, deviceId, node.right);
      if (left === null || right === null) return null;
      switch (node.op) {
        case "add": return left + right;
        case "sub": return left - right;
        case "mul": return left * right;
        case "div": return right === 0 ? null : left / right;
      }
    }
    default:
      throw new Error(`evaluateNumeric: beklenmeyen node tipi '${(node as any).type}'`);
  }
}

// AST'yi recursive olarak boolean bir sonuca indirger (comparison/logical dugumleri icin).
// Herhangi bir yaprak (leaf) degerlendirilemezse (null donerse), TUM ifade "bu dongude
// degerlendirilemez" (null) sayilir -- kismi/eksik veriyle yanlis pozitif/negatif alarm
// uretme riskini onler (Zabbix'in nodata() ile acikca ele aldigi durumun bizdeki
// varsayilan, guvenli davranisi).
export async function evaluateExpression(pool: Pool, tenantId: string, deviceId: string, node: AstNode): Promise<boolean | null> {
  switch (node.type) {
    case "logical": {
      // MANTIK HATASI DÜZELTMESİ: önceden alt düğümlerden HERHANGİ BİRİ null
      // (yetersiz veri) dönerse, DİĞERLERİNİN SONUCU KESİN OLSA BİLE tüm ifade
      // "değerlendirilemez" (null) sayılıyordu. Bu, üç değerli mantığın (true/
      // false/unknown) standart kısa-devre kurallarını ihlal ediyordu:
      // - OR: alt düğümlerden biri KESİN true ise, sonuç KESİN true'dur --
      //   diğerleri unknown olsa bile. (örn. "cpu_yüksek OR memory_yüksek" içinde
      //   cpu_yüksek kesin true iken memory_yüksek geçici veri eksikliğinden
      //   null dönüyorsa, önceki kod bu turda HİÇ ALARM TETİKLEMİYORDU.)
      // - AND: alt düğümlerden biri KESİN false ise, sonuç KESİN false'tur --
      //   diğerleri unknown olsa bile.
      // Sadece "belirleyici" bir sonuç YOKSA (OR için hiç true yok, AND için
      // hiç false yok) VE en az bir unknown varsa, sonuç gerçekten null'dur.
      const results = await Promise.all(node.children.map((child) => evaluateExpression(pool, tenantId, deviceId, child)));
      if (node.op === "or") {
        if (results.some((r) => r === true)) return true;
        if (results.some((r) => r === null)) return null;
        return false;
      } else {
        if (results.some((r) => r === false)) return false;
        if (results.some((r) => r === null)) return null;
        return true;
      }
    }
    case "comparison": {
      const left = await evaluateNumeric(pool, tenantId, deviceId, node.left);
      const right = await evaluateNumeric(pool, tenantId, deviceId, node.right);
      if (left === null || right === null) return null;
      switch (node.op) {
        case "gt": return left > right;
        case "lt": return left < right;
        case "gte": return left >= right;
        case "lte": return left <= right;
        case "eq": return left === right;
        case "ne": return left !== right;
      }
    }
    default:
      throw new Error(`evaluateExpression: beklenmeyen ust-seviye node tipi '${(node as any).type}'`);
  }
}
