package main

import (
	"log"
	"time"
)

const agentVersion = "0.1.0"

func main() {
	log.Println("[Agent] Başlıyor, sürüm:", agentVersion)

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("[Agent] Config dosyası (agent_config.json) okunamadı: %v", err)
	}

	if cfg.DeviceID == "" || cfg.PSK == "" {
		log.Println("[Agent] Henüz kayıtlı değil, otomatik kayıt deneniyor...")
		if err := registerWithRetry(cfg); err != nil {
			log.Fatalf("[Agent] Kayıt kalıcı olarak başarısız: %v", err)
		}
		log.Println("[Agent] Kayıt başarılı, device_id:", cfg.DeviceID)
	}

	// Faz F: config.json'daki "plugins" bölümünde tanımlı native plugin'leri
	// (Docker/PostgreSQL/Redis vb.) başlat -- bu, sunucudan gelen item'ların
	// "connection_config.plugin" alanına göre yönlendirileceği asıl mekanizma.
	initPlugins(cfg)

	go func() {
		ticker := time.NewTicker(time.Duration(cfg.HeartbeatSeconds) * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if err := sendHeartbeat(cfg); err != nil {
				log.Println("[Agent] Heartbeat hatası (sunucu geçici olarak erişilemez olabilir):", err)
			}
		}
	}()

	// Kendi kendini güncelleme kontrolü — başlangıçta bir kez, sonra günde bir kez.
	go func() {
		checkForUpdate(cfg)
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			checkForUpdate(cfg)
		}
	}()

	// Sunucudan "hangi item'ları toplamalıyım" listesini periyodik senkronize et
	// (RefreshItemsSeconds, Zabbix'in RefreshActiveChecks karşılığı). ÖNEMLİ: bu
	// endpoint (GET /agent/items) Faz E'nin önceki sürümünde hiç çağrılmıyordu —
	// template atamaları agent'a hiçbir etki etmiyordu. Şimdi gerçekten kullanılıyor.
	syncServerItems(cfg) // başlangıçta bir kez, döngü beklemeden
	go func() {
		ticker := time.NewTicker(time.Duration(cfg.RefreshItemsSeconds) * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			syncServerItems(cfg)
		}
	}()

	ticker := time.NewTicker(time.Duration(cfg.MetricsSeconds) * time.Second)
	defer ticker.Stop()
	for {
		// Önce birikmiş kuyruğu boşaltmayı dene — böylece sunucu geri geldiğinde
		// eski veriler yeni verilerden ÖNCE, doğru kronolojik sırayla gönderilir.
		flushQueue(cfg)

		metrics := collectMetrics()
		metrics = append(metrics, runUserParameters(cfg)...)
		metrics = append(metrics, runLogWatches(cfg)...)
		metrics = append(metrics, runProcessWatches(cfg)...)
		metrics = append(metrics, collectServerDrivenMetrics()...) // sunucudan (Template atamasından) gelen item'lar
		metrics = append(metrics, collectPluginMetrics()...) // Faz F: native plugin'lerden (Docker/PostgreSQL/Redis vb.) gelen item'lar
		if err := sendMetrics(cfg, metrics, agentVersion); err != nil {
			log.Println("[Agent] Metrik gönderim hatası, yerel kuyruğa alınıyor:", err)
			if qerr := enqueueBatch(metrics, agentVersion); qerr != nil {
				log.Println("[Agent] Kuyruğa alma da başarısız (disk sorunu olabilir):", qerr)
			}
		} else {
			log.Printf("[Agent] %d metrik gönderildi\n", len(metrics))
		}
		<-ticker.C
	}
}

// registerWithRetry, ilk kayıt sırasında sunucu geçici olarak erişilemezse üstel
// geri çekilme (exponential backoff) ile dener — 1sn, 2sn, 4sn, 8sn... maksimum 60sn.
func registerWithRetry(cfg *Config) error {
	backoff := time.Second
	const maxBackoff = 60 * time.Second
	const maxAttempts = 10

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := register(cfg); err == nil {
			return nil
		} else {
			lastErr = err
			log.Printf("[Agent] Kayıt denemesi %d/%d başarısız: %v (yeniden denemeden önce %v bekleniyor)\n", attempt, maxAttempts, err, backoff)
		}
		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
	return lastErr
}
