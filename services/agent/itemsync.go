package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"sync"
)

// serverItem, GET /agent/items'tan gelen tek bir item tanımı.
type serverItem struct {
	MetricName       string                 `json:"metric_name"`
	ConnectionConfig map[string]interface{} `json:"connection_config"`
}

// serverItems, sunucudan en son çekilen item listesini tutar — RefreshItemsSeconds
// aralığında güncellenir, ana metrik döngüsü tarafından okunur (mutex ile korunur,
// iki goroutine farklı zamanlarda erişebileceği için).
var (
	serverItemsMu sync.RWMutex
	serverItems   []serverItem
)

// syncServerItems, sunucudan "bu cihaz için hangi item'ları toplamalıyım" listesini
// çeker ve yerel önbelleğe yazar. Bu, Faz E'nin önceki sürümünde HİÇ ÇAĞRILMAYAN,
// dolayısıyla ölü kalan bir endpoint'i (GET /agent/items) gerçekten devreye sokar.
// GÜVENLİK DÜZELTMESİ: PSK artık query string yerine POST body'de gönderiliyor
// (heartbeat/metrics endpoint'leriyle tutarlı, secret'ın loglara sızmasını önler).
func syncServerItems(cfg *Config) {
	body, _ := json.Marshal(map[string]string{"device_id": cfg.DeviceID, "psk": cfg.PSK})
	resp, err := httpClient.Post(cfg.ServerURL+"/api/v1/agent/items", "application/json", bytes.NewReader(body))
	if err != nil {
		logf("[ItemSync] Item listesi çekilemedi: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		logf("[ItemSync] Item listesi reddedildi (%d)", resp.StatusCode)
		return
	}

	var items []serverItem
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		logf("[ItemSync] Item yanıtı çözümlenemedi: %v", err)
		return
	}

	serverItemsMu.Lock()
	serverItems = items
	serverItemsMu.Unlock()
}

// collectServerDrivenMetrics, sunucudan senkronize edilmiş item listesindeki
// "proc.num tarzı" (process_pattern parametreli) item'ları işleyip gerçek process
// sayılarını döner — Zabbix şablonlarındaki proc.num[isim] item'larının karşılığı.
func collectServerDrivenMetrics() []metricPayload {
	serverItemsMu.RLock()
	items := serverItems
	serverItemsMu.RUnlock()

	var results []metricPayload
	for _, item := range items {
		pattern, ok := item.ConnectionConfig["process_pattern"].(string)
		if !ok || pattern == "" {
			continue // bu item tipi (henüz) desteklenmiyor, atla
		}
		count := countProcessesByPattern(pattern)
		results = append(results, metricPayload{MetricName: item.MetricName, Value: float64(count)})
	}
	return results
}
