package main

import "sync"

// Monitoring Proxy: kullanıcıyla konuşulup kararlaştırılan tasarım -- agent, merkezden
// (ya da kendisini proxy'ye yönlendiren merkez, proxy şeffaf bir relay olduğu için
// fark etmez) gelen bir redirect_server_url alanı görürse kendi ServerURL'ini günceller.
// GÜVENLİK AĞI: yeni adrese art arda ulaşılamazsa (yanlış/erişilemez bir proxy atanmış
// olabilir), N başarısız denemeden sonra son bilinen ÇALIŞAN adrese otomatik geri döner
// -- yanlış bir atama cihazı kalıcı olarak kör bırakmasın diye.
var redirectMu sync.Mutex
var lastKnownGoodServerURL string
var consecutiveHeartbeatFailures int

const maxConsecutiveFailuresBeforeFallback = 5

// recordHeartbeatSuccess, geçerli ServerURL ile bir heartbeat BAŞARILI olduğunda
// çağrılır -- bu adresi "son bilinen çalışan adres" olarak işaretler.
func recordHeartbeatSuccess(cfg *Config) {
	redirectMu.Lock()
	defer redirectMu.Unlock()
	lastKnownGoodServerURL = cfg.ServerURL
	consecutiveHeartbeatFailures = 0
}

// recordHeartbeatFailure, geçerli ServerURL'e bir heartbeat BAŞARISIZ olduğunda
// çağrılır -- eşik aşılırsa VE farklı, bilinen iyi bir adres varsa oraya otomatik
// geri döner.
func recordHeartbeatFailure(cfg *Config) {
	redirectMu.Lock()
	defer redirectMu.Unlock()
	consecutiveHeartbeatFailures++
	if consecutiveHeartbeatFailures >= maxConsecutiveFailuresBeforeFallback &&
		lastKnownGoodServerURL != "" && lastKnownGoodServerURL != cfg.ServerURL {
		logf("[Redirect] %s adresine %d kez art arda ulaşılamadı, son bilinen çalışan adrese (%s) geri dönülüyor",
			cfg.ServerURL, consecutiveHeartbeatFailures, lastKnownGoodServerURL)
		cfg.ServerURL = lastKnownGoodServerURL
		consecutiveHeartbeatFailures = 0
		if err := saveConfig(cfg); err != nil {
			logf("[Redirect] Uyarı: geri dönülen adres diske yazılamadı: %v", err)
		}
	}
}

// applyRedirect, sunucudan (core ya da onu ileten proxy, fark etmez -- şeffaf relay)
// gelen redirect_server_url'i işler -- mevcut adresten FARKLIYSA config'i günceller ve
// diske yazar, bir sonraki istekten itibaren yeni adrese bağlanılır. Eski adres, geri
// dönüş güvenlik ağı için "son bilinen çalışan adres" olarak saklanır.
func applyRedirect(cfg *Config, redirectServerURL string) {
	if redirectServerURL == "" || redirectServerURL == cfg.ServerURL {
		return
	}
	redirectMu.Lock()
	lastKnownGoodServerURL = cfg.ServerURL
	consecutiveHeartbeatFailures = 0
	redirectMu.Unlock()

	logf("[Redirect] Sunucu yönlendirmesi alındı: %s -> %s", cfg.ServerURL, redirectServerURL)
	cfg.ServerURL = redirectServerURL
	if err := saveConfig(cfg); err != nil {
		logf("[Redirect] Uyarı: yeni adres diske yazılamadı: %v", err)
	}
}
