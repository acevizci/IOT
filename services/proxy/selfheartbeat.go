package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// proxyHeartbeatPayload -- kullanıcıyla konuşulup kararlaştırılan self-metrikler:
// bu sinyal cihaz heartbeat'lerinden AYRI bir kanaldır, alarm-engine bunu proxy'nin
// kendisinin (yani bütün sitenin) erişilebilirliğini izlemek için kullanır.
type proxyHeartbeatPayload struct {
	ProxyID              string `json:"proxy_id"`
	ProxySecret          string `json:"proxy_secret"`
	ConnectedDeviceCount int    `json:"connected_device_count"`
	PendingQueueSize     int    `json:"pending_queue_size"`
	ProxyVersion         string `json:"proxy_version"`
	DiskUsageBytes       int64  `json:"disk_usage_bytes,omitempty"`
	LastSuccessfulSyncAt string `json:"last_successful_sync_at,omitempty"`
}

func runSelfHeartbeatLoop(cfg *Config, srv *Server) {
	for {
		sendSelfHeartbeat(cfg, srv)
		heartbeatSeconds, _, _ := srv.settings.Snapshot()
		time.Sleep(time.Duration(heartbeatSeconds) * time.Second)
	}
}

func sendSelfHeartbeat(cfg *Config, srv *Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// "Bağlı cihaz" = son 1 saat içinde bu proxy'den en az bir register/heartbeat/
	// metrics geçmiş cihaz -- agent'ın en yavaş döngüsünden (RefreshActiveChecks,
	// varsayılan 120sn) bile kat kat geniş bir pencere, geçici bir gecikmeyi
	// "bağlantı koptu" gibi yanlış yorumlamamak için.
	var connectedDeviceCount int
	_ = srv.pool.QueryRow(ctx, `SELECT count(*) FROM device_cache WHERE last_seen_at > now() - interval '1 hour'`).Scan(&connectedDeviceCount)

	var pendingQueueSize int
	_ = srv.pool.QueryRow(ctx, `SELECT count(*) FROM metric_queue`).Scan(&pendingQueueSize)

	// Proxy'nin disk ayak izi pratikte kendi Postgres'inin (cache+kuyruk) boyutudur --
	// platforma özgü syscall (statfs vb.) gerekmeden, doğrudan Postgres'ten sorulur.
	var diskUsageBytes int64
	_ = srv.pool.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&diskUsageBytes)

	payload := proxyHeartbeatPayload{
		ProxyID: srv.state.ProxyID, ProxySecret: srv.state.ProxySecret,
		ConnectedDeviceCount: connectedDeviceCount, PendingQueueSize: pendingQueueSize,
		ProxyVersion: proxyVersion, DiskUsageBytes: diskUsageBytes,
	}
	if lastSync, ok := srv.lastSyncAt(); ok {
		payload.LastSuccessfulSyncAt = lastSync.Format(time.RFC3339)
	}
	body, _ := json.Marshal(payload)
	resp, err := httpClient.Post(cfg.CoreURL+"/api/v1/proxy/heartbeat", "application/json", bytes.NewReader(body))
	if err != nil {
		logf("[SelfHeartbeat] Merkeze ulaşılamadı: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		logf("[SelfHeartbeat] Merkez reddetti (%d)", resp.StatusCode)
	}
}
