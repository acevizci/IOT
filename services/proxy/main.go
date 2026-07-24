package main

import (
	"log"
	"net/http"
)

const proxyVersion = "0.1.0"

func main() {
	cfg := loadConfig()
	if cfg.DatabaseURL == "" {
		log.Fatal("[Proxy] DATABASE_URL tanımlı değil")
	}
	if cfg.CoreURL == "" {
		log.Fatal("[Proxy] CORE_URL tanımlı değil")
	}

	pool, err := connectDB(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("[Proxy] Postgres'e bağlanılamadı: %v", err)
	}
	defer pool.Close()

	if err := runMigrations(pool); err != nil {
		log.Fatalf("[Proxy] Migration'lar uygulanamadı: %v", err)
	}

	state, ok := loadProxyState(pool)
	if !ok {
		log.Println("[Proxy] Henüz kayıtlı değil, core'a kaydolunuyor...")
		state, err = registerWithCore(cfg, pool)
		if err != nil {
			log.Fatalf("[Proxy] Kayıt başarısız: %v", err)
		}
		log.Println("[Proxy] Kayıt başarılı, proxy_id:", state.ProxyID)
	} else {
		log.Println("[Proxy] Zaten kayıtlı, proxy_id:", state.ProxyID)
	}

	genericProxy, err := newGenericAgentProxy(cfg.CoreURL)
	if err != nil {
		log.Fatalf("[Proxy] Genel ters proxy kurulamadı: %v", err)
	}
	srv := &Server{cfg: cfg, pool: pool, state: state, settings: NewSettings(cfg), genericProxy: genericProxy}

	go runSelfHeartbeatLoop(cfg, srv)
	go runConfigPullLoop(cfg, srv)
	go runMetricsFlushLoop(cfg, srv)
	go runLatestReleaseCheckLoop(cfg)

	log.Println("[Proxy] Başlıyor, sürüm:", proxyVersion, "dinleniyor:", cfg.ListenAddr)
	if err := http.ListenAndServe(cfg.ListenAddr, srv.Handler()); err != nil {
		log.Fatalf("[Proxy] HTTP sunucusu çöktü: %v", err)
	}
}
