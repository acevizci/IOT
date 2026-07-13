package main

import (
	"encoding/json"
	"os"
)

// Config, agent'ın kalıcı ayar dosyası (config.json). RegistrationToken sadece ilk
// çalıştırmada kullanılır; kayıt başarılı olunca DeviceID/PSK bu dosyaya yazılıp
// bir daha kayıt token'ı hiç kullanılmaz (Zabbix'in "aktif agent otomatik kaydı" deseni).
// UserParameter, Zabbix'in aynı isimli özelliğinin karşılığı: kullanıcı tanımlı bir
// komutun çıktısını bir metrik olarak gönderme. Güvenlik: UnsafeUserParameters=false
// (varsayılan) iken özel karakter (;|`$()) içeren komutlar reddedilir.
type UserParameter struct {
	MetricName string `json:"metric_name"`
	Command    string `json:"command"`
}

// LogWatch, bir log dosyasındaki belirli bir deseni (regex) sayıp metrik olarak gönderir.
// Dosyadaki son okunan pozisyon (offset) iki kontrol arasında saklanır (tail benzeri).
type LogWatch struct {
	MetricName string `json:"metric_name"`
	FilePath   string `json:"file_path"`
	Pattern    string `json:"pattern"` // regex — örn. "ERROR|CRITICAL"
}

// ProcessWatch, belirli bir isim deseniyle eşleşen process'lerin sayısını metrik olarak gönderir.
type ProcessWatch struct {
	MetricName  string `json:"metric_name"`
	NamePattern string `json:"name_pattern"` // regex — process adına uygulanır
}

type Config struct {
	ServerURL             string          `json:"server_url"`
	RegistrationToken     string          `json:"registration_token,omitempty"`
	Hostname              string          `json:"hostname,omitempty"`
	DeviceID              string          `json:"device_id,omitempty"`
	PSK                   string          `json:"psk,omitempty"`
	HeartbeatSeconds      int             `json:"heartbeat_seconds"`
	MetricsSeconds        int             `json:"metrics_seconds"`
	RefreshItemsSeconds   int             `json:"refresh_items_seconds"` // Zabbix'in RefreshActiveChecks karşılığı
	UnsafeUserParameters  bool            `json:"unsafe_user_parameters"` // varsayılan false — Zabbix'in güvenli varsayılanı
	MaxLinesPerSecond     int             `json:"max_lines_per_second"`  // log izlemede sel önleme, Zabbix varsayılanı 20
	UserParameters        []UserParameter `json:"user_parameters,omitempty"`
	LogWatches            []LogWatch      `json:"log_watches,omitempty"`
	ProcessWatches        []ProcessWatch  `json:"process_watches,omitempty"`
	Plugins               map[string]map[string]interface{} `json:"plugins,omitempty"` // Faz F: native plugin ayarları (docker/postgres/redis vb.)
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
	if cfg.MaxLinesPerSecond == 0 {
		cfg.MaxLinesPerSecond = 20 // Zabbix'in MaxLinesPerSecond varsayılanı
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
