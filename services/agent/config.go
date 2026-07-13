package main

import (
	"encoding/json"
	"os"
)

// Config, agent'ın kalıcı ayar dosyası (config.json). RegistrationToken sadece ilk
// çalıştırmada kullanılır; kayıt başarılı olunca DeviceID/PSK bu dosyaya yazılıp
// bir daha kayıt token'ı hiç kullanılmaz (Zabbix'in "aktif agent otomatik kaydı" deseni).
type Config struct {
	ServerURL           string `json:"server_url"`
	RegistrationToken   string `json:"registration_token,omitempty"`
	Hostname            string `json:"hostname,omitempty"`
	DeviceID            string `json:"device_id,omitempty"`
	PSK                 string `json:"psk,omitempty"`
	HeartbeatSeconds    int    `json:"heartbeat_seconds"`
	MetricsSeconds      int    `json:"metrics_seconds"`
	RefreshItemsSeconds int    `json:"refresh_items_seconds"` // Zabbix'in RefreshActiveChecks karşılığı
}

const configPath = "agent_config.json"

func loadConfig() (*Config, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	// Zabbix'in gerçek varsayılanlarıyla tutarlı (RefreshActiveChecks=120).
	if cfg.HeartbeatSeconds == 0 {
		cfg.HeartbeatSeconds = 10
	}
	if cfg.MetricsSeconds == 0 {
		cfg.MetricsSeconds = 60
	}
	if cfg.RefreshItemsSeconds == 0 {
		cfg.RefreshItemsSeconds = 120
	}
	return &cfg, nil
}

func saveConfig(cfg *Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, data, 0600) // sadece sahibi okuyabilir — PSK içeriyor
}
