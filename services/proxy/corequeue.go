package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// newBatchID, core'un proxy_metric_batches.batch_id (UUID) kolonuna uyan rastgele bir
// kimlik üretir -- idempotency'nin (aynı batch iki kez işlenmesin) temeli. Harici bir
// UUID kütüphanesi eklemeye gerek yok, RFC4122 v4 formatını üretmek yeterli.
func newBatchID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Tek seferde flush edilecek maksimum satır -- saatlerce süren bir kesintiden sonra
// birikmiş dev bir kuyruğu TEK bir HTTP isteğinde göndermemek için (zaman aşımı/bellek
// riski). Kuyruk birden fazla flush turunda kademeli olarak boşalır.
const maxRowsPerFlush = 5000

type queuedMetricRow struct {
	ID           int64
	DeviceID     string
	Psk          string
	AgentVersion string
	MetricName   string
	Value        float64
	Unit         string
	Interface    string
	TagsJSON     string
	Timestamp    time.Time
}

type batchMetricPayload struct {
	MetricName string            `json:"metric_name"`
	Value      float64           `json:"value"`
	Unit       string            `json:"unit,omitempty"`
	Interface  string            `json:"interface,omitempty"`
	Tags       map[string]string `json:"tags,omitempty"`
	Timestamp  string            `json:"timestamp"`
}

type deviceBatchPayload struct {
	DeviceID     string                `json:"device_id"`
	Psk          string                `json:"psk"`
	AgentVersion string                `json:"agent_version,omitempty"`
	Metrics      []batchMetricPayload  `json:"metrics"`
}

// runMetricsFlushLoop, kullanıcıyla konuşulup kararlaştırılan tasarımın asıl vaadini
// yerine getirir: yerel kuyrukta biriken (agent'ların ANINDA yerel olarak teslim ettiği)
// metrikleri periyodik olarak core'a TEK bir batch halinde, ORİJİNAL zaman damgalarıyla
// iletir. Merkez ulaşılamazsa kuyruk büyümeye devam eder (bir sonraki turda tekrar
// denenir) -- veri kaybı olmaz, sadece gecikir.
func runMetricsFlushLoop(cfg *Config, srv *Server) {
	for {
		_, flushSeconds, retentionLimit := srv.settings.Snapshot()
		time.Sleep(time.Duration(flushSeconds) * time.Second)

		if err := flushOnce(cfg, srv); err != nil {
			logf("[Flush] Kuyruk boşaltılamadı, bir sonraki turda tekrar denenecek: %v", err)
		}
		if err := enforceQueueRetention(srv, retentionLimit); err != nil {
			logf("[Flush] Kuyruk taşma temizliği başarısız: %v", err)
		}
	}
}

func flushOnce(cfg *Config, srv *Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rows, err := srv.pool.Query(ctx,
		`SELECT id, device_id, psk, COALESCE(agent_version, ''), metric_name, value,
		        COALESCE(unit, ''), COALESCE(interface, ''), COALESCE(tags_json, ''), metric_timestamp
		 FROM metric_queue ORDER BY id ASC LIMIT $1`,
		maxRowsPerFlush,
	)
	if err != nil {
		return err
	}
	var queued []queuedMetricRow
	for rows.Next() {
		var q queuedMetricRow
		if err := rows.Scan(&q.ID, &q.DeviceID, &q.Psk, &q.AgentVersion, &q.MetricName, &q.Value, &q.Unit, &q.Interface, &q.TagsJSON, &q.Timestamp); err != nil {
			rows.Close()
			return err
		}
		queued = append(queued, q)
	}
	rows.Close()

	if len(queued) == 0 {
		return nil
	}

	// device_id'ye göre grupla -- core'un batch sözleşmesi (device_batches) bunu bekliyor.
	grouped := map[string]*deviceBatchPayload{}
	order := []string{}
	ids := make([]int64, 0, len(queued))
	for _, q := range queued {
		ids = append(ids, q.ID)
		db, ok := grouped[q.DeviceID]
		if !ok {
			db = &deviceBatchPayload{DeviceID: q.DeviceID, Psk: q.Psk, AgentVersion: q.AgentVersion}
			grouped[q.DeviceID] = db
			order = append(order, q.DeviceID)
		}
		var tags map[string]string
		if q.TagsJSON != "" && q.TagsJSON != "null" {
			_ = json.Unmarshal([]byte(q.TagsJSON), &tags)
		}
		db.Metrics = append(db.Metrics, batchMetricPayload{
			MetricName: q.MetricName, Value: q.Value, Unit: q.Unit, Interface: q.Interface,
			Tags: tags, Timestamp: q.Timestamp.UTC().Format(time.RFC3339),
		})
	}
	deviceBatches := make([]deviceBatchPayload, 0, len(order))
	for _, deviceID := range order {
		deviceBatches = append(deviceBatches, *grouped[deviceID])
	}

	payload := map[string]interface{}{
		"proxy_id":       srv.state.ProxyID,
		"proxy_secret":   srv.state.ProxySecret,
		"batch_id":       newBatchID(),
		"device_batches": deviceBatches,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	resp, err := httpClient.Post(cfg.CoreURL+"/api/v1/proxy/metrics/batch", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("core batch isteğini reddetti (%d)", resp.StatusCode)
	}

	// SADECE bu turda gönderilen satırları sil -- flush sırasında yeni gelen satırları
	// (race condition) ASLA silme, bir sonraki tur onları da kapsayacak.
	_, err = srv.pool.Exec(ctx, `DELETE FROM metric_queue WHERE id = ANY($1)`, ids)
	if err != nil {
		return fmt.Errorf("core'a başarıyla gönderildi ama yerel kuyruktan silinemedi (bir sonraki turda mükerrer gönderilebilir, core idempotent olduğu için ZARARSIZ): %w", err)
	}
	srv.markSyncSuccessful()
	logf("[Flush] %d metrik, %d cihaz için core'a iletildi", len(queued), len(deviceBatches))
	return nil
}

// enforceQueueRetention, agent'ın maxQueueFiles (FIFO-drop-oldest) deseninin DB'li
// karşılığı -- kuyruk sınırsız büyümesin diye (uzun süreli merkez kesintisi + disk
// alanı sınırlı olabilir), sınır aşılırsa EN ESKİ fazlalık silinir, bir uyarı loglanır.
func enforceQueueRetention(srv *Server, retentionLimit int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var total int
	if err := srv.pool.QueryRow(ctx, `SELECT count(*) FROM metric_queue`).Scan(&total); err != nil {
		return err
	}
	if total <= retentionLimit {
		return nil
	}
	excess := total - retentionLimit
	tag, err := srv.pool.Exec(ctx,
		`DELETE FROM metric_queue WHERE id IN (SELECT id FROM metric_queue ORDER BY id ASC LIMIT $1)`,
		excess,
	)
	if err != nil {
		return err
	}
	logf("[Flush] Kuyruk sınırı (%d) aşıldı, %d eski kayıt silindi", retentionLimit, tag.RowsAffected())
	return nil
}
