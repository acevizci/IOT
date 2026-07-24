package main

import (
	"encoding/json"
	"os"
)

// Config, proxy'nin kalıcı ayar dosyası (proxy_state.json). Bu dosya sadece BOOTSTRAP
// bilgisini (kayıt öncesi/kayıt anı) tutar -- register olduktan sonraki proxy_id/proxy_secret
// KENDİ Postgres'ine yazılır (kullanıcıyla konuşulup kararlaştırılan tasarım: container'lar
// ephemeral, ama Postgres volume'u kalıcı -- ayrı bir state dosyasına gerek yok). Bu dosya,
// register OLMADAN ÖNCE gereken tek şeyi (core adresi + tek kullanımlık token) taşır.
type Config struct {
	CoreURL            string `json:"core_url"`
	RegistrationToken  string `json:"registration_token,omitempty"`
	ProxyName          string `json:"proxy_name"`
	Address            string `json:"address,omitempty"` // Dashboard'a bildirilecek host:port -- boşsa Dashboard'dan elle girilir
	DatabaseURL        string `json:"database_url"`
	ListenAddr         string `json:"listen_addr"`
	HeartbeatSeconds   int    `json:"heartbeat_seconds"`
	MetricsFlushSeconds int   `json:"metrics_flush_seconds"`
	ConfigPullSeconds  int    `json:"config_pull_seconds"`
	QueueRetentionLimit int   `json:"queue_retention_limit"`
}

const configPath = "proxy_config.json"

// loadConfig, öncelikle ortam değişkenlerinden (Docker Compose .env ile beslenir) okur --
// dosya SADECE register sonrası bootstrap token'ının bir daha kullanılmaması için var
// (agent'ın config.go'daki saveConfig deseniyle aynı fikir).
func loadConfig() *Config {
	cfg := &Config{
		CoreURL:             getEnv("CORE_URL", ""),
		RegistrationToken:   getEnv("REGISTRATION_TOKEN", ""),
		ProxyName:           getEnv("PROXY_NAME", ""),
		Address:             getEnv("PROXY_ADDRESS", ""),
		DatabaseURL:         getEnv("DATABASE_URL", ""),
		ListenAddr:          getEnv("LISTEN_ADDR", ":8090"), // container içi sabit port -- host eşlemesi docker-compose.yml/.env'de
		HeartbeatSeconds:    30,
		MetricsFlushSeconds: 30,
		ConfigPullSeconds:   60,
		QueueRetentionLimit: 500, // agent'ın maxQueueFiles deseniyle tutarlı
	}

	// Daha önce bootstrap token tüketildiyse (register başarılı olduysa), dosyadaki
	// kayıt boş bırakılır -- ortam değişkeninde token hâlâ dursa bile (örn. .env
	// silinmediyse) bir daha KULLANILMAZ, sadece proxy_state tablosundaki kimlik kullanılır.
	if data, err := os.ReadFile(configPath); err == nil {
		var stored Config
		if json.Unmarshal(data, &stored) == nil && stored.RegistrationToken == "" {
			cfg.RegistrationToken = ""
		}
	}
	return cfg
}

// markTokenConsumed, register başarılı olduktan sonra bootstrap token'ının BİR DAHA
// kullanılmamasını sağlamak için diske yazılır (container yeniden başlasa bile, .env'de
// token hâlâ dursa bile tekrar register denenmez -- proxy_state tablosunda zaten kimlik var).
func markTokenConsumed() error {
	data, err := json.MarshalIndent(Config{RegistrationToken: ""}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, data, 0600)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
