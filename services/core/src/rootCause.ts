import { Pool } from "pg";

// RCA Confidence Motoru -- paylaşılan çekirdek: hem /devices/:id/diagnostics
// endpoint'i HEM gelecekteki correlation/incident motoru bu fonksiyonu çağırır
// (kod tekrarını önlemek için, kullanıcıyla onaylanmış mimari karar).
//
// Onaylanan formül: confidence = relationship_weight × temporal_score × hierarchy_weight × hop_decay
// (Not: ilk onayda "/ hop_decay" yazılmıştı -- bu ters yönde çalışırdı, mesafe
// arttıkça confidence'ı ARTIRIRDI. Kullanıcıyla teyit edilip "×" olarak düzeltildi.)
//
// - relationship_weight: yol boyunca EN ZAYIF halka (min), her segment kendi
//   kaynağına göre: LLDP/CDP=0.95, VMware hiyerarşisi=0.90, manuel=0.70,
//   trafik=tenant içi yüzdelik dilime göre 0.40-0.60 (endüstri pratiği: sabit
//   MB eşiği yerine göreli NTILE(3) kullanılıyor, farklı ölçekteki ortamlarda
//   da anlamlı kalması için).
// - temporal_score: 100 / (1 + hours_earlier/6) -- SADECE komşunun alarmı
//   bizimkinden önce/eşit zamanda başladıysa hesaplanır, aksi halde 0.
// - hierarchy_weight: clamp(neighbor_degree/own_degree, 0.5, 1.5) -- daha
//   "merkezi" (çok bağlantılı) bir komşu ağırlığı artırır ama sınırsız değil.
// - hop_decay: 0.8 ^ (hop_distance - 1) -- her ek adımda çarpan azalır.

export interface RootCauseCandidate {
  id: string;
  name: string;
  hop_distance: number;
  confidence: number;
  relationship_weight: number;
  temporal_score: number;
  hierarchy_weight: number;
  hop_decay: number;
  open_alert_message: string | null;
  open_alert_triggered_at: string | null;
  open_alert_severity: string | null;
  open_alert_id: string | null;
}

export interface RootCauseResult {
  anchor_time: string | null;
  candidates: RootCauseCandidate[];
}

const ADJACENCY_AND_CHAIN_SQL = `
  WITH RECURSIVE adjacency AS (
    -- Fiziksel bağlantılar (device_links) -- her iki yönde. Ağırlık, keşif
    -- yöntemine göre: LLDP/CDP otomatik keşif çok güvenilir (0.95), APM
    -- servis<->host senkronizasyonu da otomatik ama trace verisine dayanıyor
    -- (0.85, LLDP kadar değil çünkü host.name eşleştirmesi isimle yapılıyor,
    -- ağ-seviyesi keşif kadar kesin değil), manuel eklenen bağlantılar en az
    -- güvenilir (0.70, insan hatası riski).
    SELECT device_a_id AS a, device_b_id AS b,
           CASE WHEN discovery_method IN ('lldp','cdp') THEN 0.95
                WHEN discovery_method = 'service_host' THEN 0.85
                ELSE 0.70 END AS relationship_weight
    FROM device_links WHERE tenant_id = $1
    UNION ALL
    SELECT device_b_id AS a, device_a_id AS b,
           CASE WHEN discovery_method IN ('lldp','cdp') THEN 0.95
                WHEN discovery_method = 'service_host' THEN 0.85
                ELSE 0.70 END AS relationship_weight
    FROM device_links WHERE tenant_id = $1
    UNION ALL
    -- VMware hiyerarşisi (Host<->vCenter) -- her iki yönde, sabit ağırlık.
    SELECT m.device_id AS a, g.vmware_source_device_id AS b, 0.90 AS relationship_weight
    FROM device_group_members m JOIN device_groups g ON g.id = m.device_group_id
    WHERE g.vmware_source_device_id IS NOT NULL
    UNION ALL
    SELECT g.vmware_source_device_id AS a, m.device_id AS b, 0.90 AS relationship_weight
    FROM device_group_members m JOIN device_groups g ON g.id = m.device_group_id
    WHERE g.vmware_source_device_id IS NOT NULL
    UNION ALL
    -- Trafik-bazlı ilişkiler (NetFlow materyalizasyonu) -- her iki yönde.
    -- Ağırlık, o tenant'ın KENDİ trafik dağılımı içinde yüzdelik dilime göre
    -- (NTILE(3)): üst 1/3 -> 0.60, orta -> 0.50, alt -> 0.40. Sabit bir MB
    -- eşiği yerine göreli eşikleme kullanılıyor -- küçük bir test ortamında
    -- da büyük bir datacenter'da da anlamlı kalması için.
    SELECT tl.device_a_id AS a, tl.device_b_id AS b, tw.relationship_weight
    FROM traffic_links tl
    JOIN (
      SELECT id, CASE NTILE(3) OVER (ORDER BY total_bytes)
               WHEN 3 THEN 0.60 WHEN 2 THEN 0.50 ELSE 0.40 END AS relationship_weight
      FROM traffic_links WHERE tenant_id = $1
    ) tw ON tw.id = tl.id
    WHERE tl.tenant_id = $1
    UNION ALL
    SELECT tl.device_b_id AS a, tl.device_a_id AS b, tw.relationship_weight
    FROM traffic_links tl
    JOIN (
      SELECT id, CASE NTILE(3) OVER (ORDER BY total_bytes)
               WHEN 3 THEN 0.60 WHEN 2 THEN 0.50 ELSE 0.40 END AS relationship_weight
      FROM traffic_links WHERE tenant_id = $1
    ) tw ON tw.id = tl.id
    WHERE tl.tenant_id = $1
  ),
  chain AS (
    SELECT $2::uuid AS id, 0 AS hop_distance, ARRAY[$2::uuid] AS visited_path, 1.0::float8 AS min_relationship_weight
    UNION ALL
    SELECT adj.b, chain.hop_distance + 1, chain.visited_path || adj.b,
           LEAST(chain.min_relationship_weight, adj.relationship_weight)
    FROM chain
    JOIN adjacency adj ON adj.a = chain.id
    WHERE chain.hop_distance < 5 AND NOT (adj.b = ANY(chain.visited_path))
  ),
  -- Bir cihaza birden fazla yoldan ulaşılabilir (farklı hop/ağırlık ile).
  -- En kısa yolu, o hop'ta birden fazla seçenek varsa en yüksek (en iyimser)
  -- min_relationship_weight'i olanı seçiyoruz -- deterministik ve basit.
  ranked_chain AS (
    SELECT DISTINCT ON (id) id, hop_distance, min_relationship_weight
    FROM chain
    WHERE id != $2
    ORDER BY id, hop_distance ASC, min_relationship_weight DESC
  ),
  degrees AS (
    SELECT a AS device_id, COUNT(DISTINCT b) AS degree
    FROM adjacency
    GROUP BY a
  )
  SELECT
    d.id, d.name,
    rc.hop_distance,
    rc.min_relationship_weight AS relationship_weight,
    COALESCE(own_deg.degree, 0) AS own_degree,
    COALESCE(nbr_deg.degree, 0) AS neighbor_degree,
    oldest_alert.message AS open_alert_message,
    oldest_alert.triggered_at AS open_alert_triggered_at,
    oldest_alert.severity AS open_alert_severity,
    oldest_alert.id AS open_alert_id
  FROM ranked_chain rc
  JOIN devices d ON d.id = rc.id
  LEFT JOIN degrees own_deg ON own_deg.device_id = $2
  LEFT JOIN degrees nbr_deg ON nbr_deg.device_id = rc.id
  LEFT JOIN LATERAL (
    SELECT id, message, triggered_at, severity FROM alerts
    WHERE device_id = d.id AND resolved_at IS NULL
    ORDER BY triggered_at ASC LIMIT 1
  ) oldest_alert ON true
  ORDER BY rc.hop_distance
`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function computeRootCauseCandidates(
  pool: Pool,
  tenantId: string,
  deviceId: string
): Promise<RootCauseResult> {
  // Kendi cihazımızın şu an açık en eski alarmı -- "olay ne zaman başladı"
  // referans noktası. Diğer cihazlardaki alarmlarla zamansal karşılaştırma
  // bunun üzerinden yapılır.
  const anchorResult = await pool.query(
    `SELECT MIN(triggered_at) as anchor FROM alerts WHERE tenant_id = $1 AND device_id = $2 AND resolved_at IS NULL`,
    [tenantId, deviceId]
  );
  const anchorTime: string | null = anchorResult.rows[0]?.anchor ?? null;
  const anchorMs = anchorTime ? new Date(anchorTime).getTime() : null;

  const neighborsResult = await pool.query(ADJACENCY_AND_CHAIN_SQL, [tenantId, deviceId]);

  const candidates: RootCauseCandidate[] = neighborsResult.rows.map((row) => {
    const hopDistance = Number(row.hop_distance);
    const relationshipWeight = Number(row.relationship_weight);
    const ownDegree = Number(row.own_degree);
    const neighborDegree = Number(row.neighbor_degree);

    const hopDecay = Math.pow(0.8, hopDistance - 1);
    const hierarchyWeight = clamp(neighborDegree / Math.max(ownDegree, 1), 0.5, 1.5);

    let temporalScore = 0;
    if (row.open_alert_triggered_at && anchorMs !== null) {
      const triggeredMs = new Date(row.open_alert_triggered_at).getTime();
      if (triggeredMs <= anchorMs) {
        const hoursEarlier = (anchorMs - triggeredMs) / (1000 * 60 * 60);
        temporalScore = 100 / (1 + hoursEarlier / 6);
      }
    }

    const rawConfidence = relationshipWeight * temporalScore * hierarchyWeight * hopDecay;
    const confidence = Math.round(clamp(rawConfidence, 0, 100));

    return {
      id: row.id,
      name: row.name,
      hop_distance: hopDistance,
      confidence,
      relationship_weight: Math.round(relationshipWeight * 100) / 100,
      temporal_score: Math.round(temporalScore * 10) / 10,
      hierarchy_weight: Math.round(hierarchyWeight * 100) / 100,
      hop_decay: Math.round(hopDecay * 100) / 100,
      open_alert_message: row.open_alert_message,
      open_alert_triggered_at: row.open_alert_triggered_at,
      open_alert_severity: row.open_alert_severity,
      open_alert_id: row.open_alert_id
    };
  });

  candidates.sort((a, b) => b.confidence - a.confidence);

  return { anchor_time: anchorTime, candidates };
}
