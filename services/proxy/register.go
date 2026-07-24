package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var httpClient = &http.Client{Timeout: 15 * time.Second}

type proxyState struct {
	ProxyID     string
	ProxySecret string
}

// loadProxyState, proxy_state tablosundan kayıtlı kimliği okur -- yoksa (henüz
// register olunmadıysa) ok=false döner.
func loadProxyState(pool *pgxpool.Pool) (proxyState, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var st proxyState
	err := pool.QueryRow(ctx, `SELECT proxy_id, proxy_secret FROM proxy_state WHERE id = 1`).Scan(&st.ProxyID, &st.ProxySecret)
	if err != nil {
		return proxyState{}, false
	}
	return st, true
}

type registerResponse struct {
	ProxyID     string `json:"proxy_id"`
	ProxySecret string `json:"proxy_secret"`
}

// registerWithCore, ilk açılışta (proxy_state tablosu boşsa) tek kullanımlık
// registration_token ile core'a kaydolur -- agent'ın client.go register() akışıyla
// AYNI desen: token bir kez kullanılır, sonraki her açılışta kendi (artık kalıcı
// Postgres'inde saklı) proxy_id/proxy_secret'ı kullanılır.
func registerWithCore(cfg *Config, pool *pgxpool.Pool) (proxyState, error) {
	if cfg.RegistrationToken == "" {
		return proxyState{}, fmt.Errorf("REGISTRATION_TOKEN tanımlı değil ve proxy henüz kayıtlı değil")
	}
	body, _ := json.Marshal(map[string]string{
		"registration_token": cfg.RegistrationToken,
		"name":               cfg.ProxyName,
		"address":            cfg.Address,
	})
	resp, err := httpClient.Post(cfg.CoreURL+"/api/v1/proxy/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return proxyState{}, fmt.Errorf("kayıt isteği başarısız: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(resp.Body)
		return proxyState{}, fmt.Errorf("kayıt reddedildi (%d): %s", resp.StatusCode, string(raw))
	}
	var result registerResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return proxyState{}, fmt.Errorf("kayıt yanıtı çözümlenemedi: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = pool.Exec(ctx,
		`INSERT INTO proxy_state (id, proxy_id, proxy_secret) VALUES (1, $1, $2)
		 ON CONFLICT (id) DO UPDATE SET proxy_id = $1, proxy_secret = $2`,
		result.ProxyID, result.ProxySecret,
	)
	if err != nil {
		return proxyState{}, fmt.Errorf("proxy kimliği yerel DB'ye yazılamadı: %w", err)
	}

	if err := markTokenConsumed(); err != nil {
		logf("[Register] Uyarı: token tüketildi ama diske yazılamadı: %v", err)
	}

	return proxyState{ProxyID: result.ProxyID, ProxySecret: result.ProxySecret}, nil
}
