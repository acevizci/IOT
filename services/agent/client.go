package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

var httpClient = &http.Client{Timeout: 15 * time.Second}

type registerResponse struct {
	DeviceID string `json:"device_id"`
	PSK      string `json:"psk"`
}

// register, agent'ın ilk çalıştırmada sunucuya kendi kendine kaydolmasını sağlar.
// Registration token bir kez kullanılır — başarılı kayıttan sonra config'e yazılan
// PSK ile devam edilir, token bir daha gönderilmez.
func register(cfg *Config) error {
	body, _ := json.Marshal(map[string]string{
		"registration_token": cfg.RegistrationToken,
		"hostname":            cfg.Hostname,
	})
	resp, err := httpClient.Post(cfg.ServerURL+"/api/v1/agent/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("kayıt isteği başarısız: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("kayıt reddedildi (%d): %s", resp.StatusCode, string(raw))
	}
	var result registerResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("kayıt yanıtı çözümlenemedi: %w", err)
	}
	cfg.DeviceID = result.DeviceID
	cfg.PSK = result.PSK
	cfg.RegistrationToken = "" // bir daha ihtiyaç yok, dosyada tutmaya gerek yok
	return saveConfig(cfg)
}

// sendHeartbeat, hafif bir canlılık sinyali gönderir.
func sendHeartbeat(cfg *Config) error {
	body, _ := json.Marshal(map[string]string{"device_id": cfg.DeviceID, "psk": cfg.PSK})
	resp, err := httpClient.Post(cfg.ServerURL+"/api/v1/agent/heartbeat", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("heartbeat reddedildi (%d): %s", resp.StatusCode, string(raw))
	}
	return nil
}

type metricPayload struct {
	MetricName string  `json:"metric_name"`
	Value      float64 `json:"value"`
	Unit       string  `json:"unit,omitempty"`
	Interface  string  `json:"interface,omitempty"`
}

// sendMetrics, tam metrik setini gzip ile sıkıştırıp gönderir.
func sendMetrics(cfg *Config, metrics []metricPayload, agentVersion string) error {
	payload := map[string]interface{}{
		"device_id":     cfg.DeviceID,
		"psk":           cfg.PSK,
		"agent_version": agentVersion,
		"metrics":       metrics,
	}
	rawBody, _ := json.Marshal(payload)

	// Content-Type application/octet-stream ile gönderiliyor — application/json olsaydı
	// Gateway'in body parser'ı gzip'li ham byte'ları JSON olarak parse etmeye çalışıp
	// bozuyordu (FST_ERR_CTP_INVALID_CONTENT_LENGTH hatasının kök nedeni buydu).
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	if _, err := gz.Write(rawBody); err != nil {
		return fmt.Errorf("gzip sıkıştırma hatası: %w", err)
	}
	gz.Close()

	req, err := http.NewRequest("POST", cfg.ServerURL+"/api/v1/agent/metrics", &compressed)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "gzip")

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("metrik gönderimi reddedildi (%d): %s", resp.StatusCode, string(raw))
	}
	return nil
}
