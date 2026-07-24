package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type proxyConfigResponse struct {
	HeartbeatSeconds    int `json:"heartbeat_seconds"`
	MetricsFlushSeconds int `json:"metrics_flush_seconds"`
	QueueRetentionLimit int `json:"queue_retention_limit"`
}

// Cihaz/item önbelleğinin ne kadar süre görülmezse "ölü" sayılıp temizleneceği --
// redirect kararı ZATEN core tarafından (her register/heartbeat/items yanıtında,
// resolveTargetServerUrl ile taze) veriliyor, bu proxy'nin kendi kararı değil -- bu
// süre SADECE önbellek hijyeni içindir (bir cihaz kalıcı olarak başka bir siteye
// taşındıysa/silindiyse, yerel önbellek sonsuza dek şişmesin diye).
const deviceCacheTTL = 30 * 24 * time.Hour

func runConfigPullLoop(cfg *Config, srv *Server) {
	for {
		pullConfigOnce(cfg, srv)
		pruneStaleCache(srv)
		time.Sleep(time.Duration(cfg.ConfigPullSeconds) * time.Second)
	}
}

func pullConfigOnce(cfg *Config, srv *Server) {
	body, _ := json.Marshal(map[string]string{"proxy_id": srv.state.ProxyID, "proxy_secret": srv.state.ProxySecret})
	resp, err := httpClient.Post(cfg.CoreURL+"/api/v1/proxy/config", "application/json", bytes.NewReader(body))
	if err != nil {
		logf("[ConfigPull] Merkeze ulaşılamadı: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		logf("[ConfigPull] Merkez reddetti (%d)", resp.StatusCode)
		return
	}
	var parsed proxyConfigResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		logf("[ConfigPull] Yanıt çözümlenemedi: %v", err)
		return
	}
	srv.settings.Update(parsed.HeartbeatSeconds, parsed.MetricsFlushSeconds, parsed.QueueRetentionLimit)
}

func pruneStaleCache(srv *Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cutoff := time.Now().Add(-deviceCacheTTL)
	tag, err := srv.pool.Exec(ctx, `DELETE FROM device_cache WHERE last_seen_at < $1`, cutoff)
	if err != nil {
		logf("[ConfigPull] Eski cihaz önbelleği temizlenemedi: %v", err)
		return
	}
	if tag.RowsAffected() > 0 {
		logf("[ConfigPull] %d eski cihaz önbellek kaydı temizlendi (%s'dan uzun süredir görülmedi)", tag.RowsAffected(), deviceCacheTTL)
	}
	_, _ = srv.pool.Exec(ctx, `DELETE FROM item_cache WHERE device_id NOT IN (SELECT device_id FROM device_cache)`)
}
