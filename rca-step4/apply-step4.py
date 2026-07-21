#!/usr/bin/env python3
# RCA Adım 4 -- mevcut 3 dosyaya count()==1 korumalı yamalar.
# Yeni dosyalar (088_incidents.sql, incidentEngine.ts) zaten kopyalandı; bu script
# SADECE var olan dosyaları düzenler. Her düzenleme için eşleşme sayısı tam 1 değilse
# O DOSYAYA HİÇ DOKUNULMAZ (güvenli). Repo kökünden çalıştırın: python3 apply-step4.py
import sys

def patch(path, edits):
    try:
        with open(path, encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        print(f"  ✗ {path}: DOSYA YOK — atlandı")
        return False
    new = content
    for i, (old, repl) in enumerate(edits, 1):
        n = new.count(old)
        if n != 1:
            print(f"  ✗ {path}: düzenleme #{i} eşleşme sayısı {n} (1 bekleniyordu) — DOSYAYA DOKUNULMADI")
            return False
        new = new.replace(old, repl, 1)
    if new == content:
        print(f"  = {path}: değişiklik yok (zaten yamalı?)")
        return True
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    print(f"  ✓ {path}: {len(edits)} düzenleme uygulandı")
    return True

# ---------- 1) rootCause.ts: open_alert_id ekle ----------
rootcause_edits = [
    # R1 interface
    ("""  open_alert_message: string | null;
  open_alert_triggered_at: string | null;
  open_alert_severity: string | null;
}""",
     """  open_alert_message: string | null;
  open_alert_triggered_at: string | null;
  open_alert_severity: string | null;
  open_alert_id: string | null;
}"""),
    # R2 LATERAL select
    ("    SELECT message, triggered_at, severity FROM alerts",
     "    SELECT id, message, triggered_at, severity FROM alerts"),
    # R3 outer select
    ("""    oldest_alert.message AS open_alert_message,
    oldest_alert.triggered_at AS open_alert_triggered_at,
    oldest_alert.severity AS open_alert_severity
  FROM ranked_chain rc""",
     """    oldest_alert.message AS open_alert_message,
    oldest_alert.triggered_at AS open_alert_triggered_at,
    oldest_alert.severity AS open_alert_severity,
    oldest_alert.id AS open_alert_id
  FROM ranked_chain rc"""),
    # R4 map return
    ("""      open_alert_message: row.open_alert_message,
      open_alert_triggered_at: row.open_alert_triggered_at,
      open_alert_severity: row.open_alert_severity
    };""",
     """      open_alert_message: row.open_alert_message,
      open_alert_triggered_at: row.open_alert_triggered_at,
      open_alert_severity: row.open_alert_severity,
      open_alert_id: row.open_alert_id
    };"""),
]

# ---------- 2) core/index.ts: yeni endpoint ----------
NEW_ENDPOINT = '''// RCA Adım 4: yeni bir alarm açıldığında alarm-engine bu endpoint'i çağırır. deviceId'nin
// (alarmın tetiklendiği cihaz) en olası kök-neden komşusunu bulur; confidence>60 ise bir
// incident'a bağlar (yoksa oluşturur, varsa etkilenen alarmı ekler).
app.post("/api/v1/internal/root-cause-check", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const body = request.body as { tenantId?: string; deviceId?: string; alertId?: string };
  if (!body?.tenantId || !body?.deviceId || !body?.alertId) {
    return reply.status(400).send({ error: "tenantId, deviceId ve alertId gerekli" });
  }
  const { tenantId, deviceId, alertId } = body;

  // candidates confidence'a göre azalan sıralı -> en olası kök-neden [0].
  const { candidates } = await computeRootCauseCandidates(pool, tenantId, deviceId);
  const top = candidates[0];
  if (!top || top.confidence <= 60) return { incident: null };

  const rootCauseDeviceId = top.id;
  const rootCauseAlertId = top.open_alert_id; // adayın en eski açık alarmı
  const conf = top.confidence;

  const existing = await pool.query(
    `SELECT id FROM incidents WHERE tenant_id = $1 AND root_cause_device_id = $2 AND status = 'open' LIMIT 1`,
    [tenantId, rootCauseDeviceId]
  );

  let incidentId: string;
  let created = false;
  if (existing.rows.length > 0) {
    incidentId = existing.rows[0].id;
    await pool.query(`UPDATE incidents SET updated_at = now() WHERE id = $1`, [incidentId]);
  } else {
    const inserted = await pool.query(
      `INSERT INTO incidents (tenant_id, root_cause_device_id, root_cause_alert_id, confidence, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [tenantId, rootCauseDeviceId, rootCauseAlertId, conf]
    );
    incidentId = inserted.rows[0].id;
    created = true;
  }

  // Tetikleyen alarmı (deviceId üzerindeki alertId) etkilenen alarm olarak ekle.
  await pool.query(
    `INSERT INTO incident_affected_alerts (incident_id, alert_id, device_id, confidence)
     VALUES ($1, $2, $3, $4) ON CONFLICT (incident_id, alert_id) DO NOTHING`,
    [incidentId, alertId, deviceId, conf]
  );

  return { incident: { id: incidentId, created, root_cause_device_id: rootCauseDeviceId, confidence: conf } };
});

'''
core_edits = [
    ('app.post("/api/v1/internal/verify-api-token", async (request, reply) => {',
     NEW_ENDPOINT + 'app.post("/api/v1/internal/verify-api-token", async (request, reply) => {'),
]

# ---------- 3) alarm-engine/index.ts: import + 4 çağrı + main wiring ----------
alarm_edits = [
    # A0 import
    ('import { processEscalations } from "./escalations.js";',
     'import { processEscalations } from "./escalations.js";\nimport { checkRootCauseAndCreateIncident, reconcileIncidents } from "./incidentEngine.js";'),
    # A1 checkNodataForRule
    ("""    severity: rule.severity || "warning",
    message
  });
}

// Veri tekrar gelmeye başladığında (rows.length >= MIN_SAMPLES_REQUIRED), açık bir""",
     """    severity: rule.severity || "warning",
    message
  });
  checkRootCauseAndCreateIncident(rule.tenant_id, deviceId, inserted.rows[0].id);
}

// Veri tekrar gelmeye başladığında (rows.length >= MIN_SAMPLES_REQUIRED), açık bir"""),
    # A2 evaluateRuleForDevice
    ("""      severity: rule.severity || "warning",
      message
    });
  } else if (!stillInAlertZone && hasOpenAlert) {""",
     """      severity: rule.severity || "warning",
      message
    });
    checkRootCauseAndCreateIncident(rule.tenant_id, deviceId, alertId);
  } else if (!stillInAlertZone && hasOpenAlert) {"""),
    # A3 checkDeviceReachability
    ("""        severity: "high",
        message
      });
    }
  }

  const resolved = await pool.query(""",
     """        severity: "high",
        message
      });
      checkRootCauseAndCreateIncident(device.tenant_id, device.id, insertedAlert.rows[0].id);
    }
  }

  const resolved = await pool.query("""),
    # A4 evaluateExpressionRuleForDevice
    ("""      severity: rule.severity || "warning", message
    });
  } else if (!problemState && hasOpenAlert) {""",
     """      severity: rule.severity || "warning", message
    });
    checkRootCauseAndCreateIncident(rule.tenant_id, deviceId, alertId);
  } else if (!problemState && hasOpenAlert) {"""),
    # A5 main: safeReconcileIncidents tanımı
    ("""  const safeRetryFailedDeliveries = safeRun(retryFailedDeliveries, "retryFailedDeliveries");

  safeEvaluateAllRules();""",
     """  const safeRetryFailedDeliveries = safeRun(retryFailedDeliveries, "retryFailedDeliveries");
  const safeReconcileIncidents = safeRun(() => reconcileIncidents(pool), "reconcileIncidents");

  safeEvaluateAllRules();"""),
    # A6 main: setInterval
    ("""  setInterval(safeRetryFailedDeliveries, CHECK_INTERVAL_MS);
}""",
     """  setInterval(safeRetryFailedDeliveries, CHECK_INTERVAL_MS);
  setInterval(safeReconcileIncidents, CHECK_INTERVAL_MS);
}"""),
]

ok = True
print("== rootCause.ts ==")
ok &= patch("services/core/src/rootCause.ts", rootcause_edits)
print("== core/index.ts ==")
ok &= patch("services/core/src/index.ts", core_edits)
print("== alarm-engine/index.ts ==")
ok &= patch("services/alarm-engine/src/index.ts", alarm_edits)

print()
if ok:
    print("TÜM YAMALAR BAŞARILI.")
    sys.exit(0)
else:
    print("EN AZ BİR YAMA BAŞARISIZ — yukarıdaki ✗ satırlarına bakın. Başarısız dosyalara DOKUNULMADI.")
    sys.exit(1)
