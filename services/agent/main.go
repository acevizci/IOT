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

	// Henüz kayıtlı değilse (DeviceID/PSK yoksa), kayıt token'ı ile otomatik kaydol.
	if cfg.DeviceID == "" || cfg.PSK == "" {
		log.Println("[Agent] Henüz kayıtlı değil, otomatik kayıt deneniyor...")
		if err := register(cfg); err != nil {
			log.Fatalf("[Agent] Kayıt başarısız: %v", err)
		}
		log.Println("[Agent] Kayıt başarılı, device_id:", cfg.DeviceID)
	}

	// Heartbeat döngüsü — hafif, sık.
	go func() {
		ticker := time.NewTicker(time.Duration(cfg.HeartbeatSeconds) * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if err := sendHeartbeat(cfg); err != nil {
				log.Println("[Agent] Heartbeat hatası:", err)
			}
		}
	}()

	// Tam metrik döngüsü — daha seyrek.
	ticker := time.NewTicker(time.Duration(cfg.MetricsSeconds) * time.Second)
	defer ticker.Stop()
	for {
		metrics := collectMetrics()
		if err := sendMetrics(cfg, metrics, agentVersion); err != nil {
			log.Println("[Agent] Metrik gönderim hatası:", err)
		} else {
			log.Printf("[Agent] %d metrik gönderildi\n", len(metrics))
		}
		<-ticker.C
	}
}
