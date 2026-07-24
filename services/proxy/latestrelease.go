package main

import (
	"encoding/json"
	"net/http"
	"time"
)

// checkLatestRelease, agent'ın latest-release deseninin karşılığı -- ama kullanıcıyla
// konuşulup kararlaştırılan tasarım gereği OTOMATİK İNDİRME/GÜNCELLEME YAPMAZ, sadece
// mevcut sürümden farklı bir sürüm varsa logo düşer (Dashboard bu bilgiyi core'daki
// proxies tablosundan -- proxy_version zaten heartbeat'te bildiriliyor -- ve
// proxy_releases'teki en güncel sürümü karşılaştırarak "güncelleme mevcut" rozetini
// üretir). Gerçek güncelleme ops tarafından manuel `docker compose pull && up -d` ile yapılır.
func runLatestReleaseCheckLoop(cfg *Config) {
	const checkInterval = 6 * time.Hour
	for {
		checkLatestReleaseOnce(cfg)
		time.Sleep(checkInterval)
	}
}

func checkLatestReleaseOnce(cfg *Config) {
	resp, err := httpClient.Get(cfg.CoreURL + "/api/v1/proxy/latest-release")
	if err != nil {
		logf("[LatestRelease] Sürüm kontrolü başarısız: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	var result struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return
	}
	if result.Version != "" && result.Version != proxyVersion {
		logf("[LatestRelease] Yeni bir sürüm mevcut: %s (mevcut: %s) -- güncelleme manuel: `docker compose pull && docker compose up -d`", result.Version, proxyVersion)
	}
}
