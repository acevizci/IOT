package main

import (
	"log"
	"os"
	"time"
)

const agentVersion = "0.2.18"

func main() {
	// EKSİKLİK DÜZELTMESİ: Windows Service modunda log çıktısı hiçbir yere gitmiyordu.
	// En başta çağrılıyor ki hem "install/start/stop" komutları hem asıl servis
	// döngüsü dosyaya loglansın.
	setupFileLogging()

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install":
			if err := installService(); err != nil {
				log.Fatalf("[Agent] Servis kurulumu başarısız: %v", err)
			}
			log.Println("[Agent] Servis başarıyla kuruldu.")
			return
		case "uninstall":
			if err := uninstallService(); err != nil {
				log.Fatalf("[Agent] Servis kaldırma başarısız: %v", err)
			}
			log.Println("[Agent] Servis kaldırıldı.")
			return
		case "start":
			if err := startService(); err != nil {
				log.Fatalf("[Agent] Servis başlatılamadı: %v", err)
			}
			log.Println("[Agent] Servis başlatıldı.")
			return
		case "stop":
			if err := stopService(); err != nil {
				log.Fatalf("[Agent] Servis durdurulamadı: %v", err)
			}
			log.Println("[Agent] Servis durduruldu.")
			return
		}
	}

	// isRunningAsService, Windows'ta gercekten SCM (Service Control Manager)
	// tarafindan baslatilip baslatilmadigini kontrol eder -- diger platformlarda
	// (service_other.go) her zaman false doner, agent normal calisir.
	isService, err := isRunningAsService()
	if err != nil {
		log.Fatalf("[Agent] Servis modu tespit edilemedi: %v", err)
	}
	if isService {
		runAsService()
		return
	}

	runAgentLoop(nil)
}

// runAgentLoop, agent'ın asıl çalışma döngüsü -- hem normal (interaktif konsol)
// modda hem Windows servisi olarak çalışırken KULLANILIR (Faz H: Windows Service
// desteği). stopCh nil ise (normal mod) sonsuza dek çalışır; servis modunda SCM
// "dur" istediğinde stopCh kapatılır ve döngü bir sonraki tick'te temiz sonlanır.
func runAgentLoop(stopCh <-chan struct{}) {
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
	// (RefreshItemsSeconds, Zabbix'in RefreshActiveChecks karşılığı).
	syncServerItems(cfg)
	syncPluginConfig(cfg)
	go func() {
		ticker := time.NewTicker(time.Duration(cfg.RefreshItemsSeconds) * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			syncServerItems(cfg)
			syncPluginConfig(cfg)
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
		metrics = append(metrics, collectPluginMetrics()...)       // Faz F: native plugin'lerden (Docker/PostgreSQL/Redis vb.) gelen item'lar
		if err := sendMetrics(cfg, metrics, agentVersion); err != nil {
			log.Println("[Agent] Metrik gönderim hatası, yerel kuyruğa alınıyor:", err)
			if qerr := enqueueBatch(metrics, agentVersion); qerr != nil {
				log.Println("[Agent] Kuyruğa alma da başarısız (disk sorunu olabilir):", qerr)
			}
		} else {
			log.Printf("[Agent] %d metrik gönderildi\n", len(metrics))
		}

		if stopCh != nil {
			select {
			case <-stopCh:
				log.Println("[Agent] Durdurma sinyali alındı, kapanıyor...")
				return
			case <-ticker.C:
			}
		} else {
			<-ticker.C
		}
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
