package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresPlugin, PostgreSQL'e KALICI bir connection pool tutarak (pgx üzerinden)
// bağlantı/kilit/çalışma-süresi gibi temel sağlık metriklerini toplar. Zabbix Agent2'nin
// pgsql.* key'lerinin ilk (en sık kullanılan) alt kümesini kapsar.
type PostgresPlugin struct {
	pool *pgxpool.Pool
	uri  string
}

func init() {
	RegisterPlugin(&PostgresPlugin{})
}

func (p *PostgresPlugin) Name() string { return "postgres" }

func (p *PostgresPlugin) Configure(config map[string]interface{}) error {
	uri, _ := config["uri"].(string)
	if uri == "" {
		return fmt.Errorf("postgres plugin için 'uri' zorunlu (örn. postgres://user:pass@host:5432/db)")
	}
	p.uri = uri
	return nil
}

func (p *PostgresPlugin) Start() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, p.uri)
	if err != nil {
		return fmt.Errorf("postgres connection pool oluşturulamadı: %w", err)
	}
	// Bağlantıyı gerçekten doğrula -- pgxpool.New başarılı dönse bile (lazy connect)
	// sunucuya hiç erişilemeyebilir (yanlış host/port/kimlik bilgisi).
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return fmt.Errorf("postgres'e ping atılamadı: %w", err)
	}
	p.pool = pool
	return nil
}

func (p *PostgresPlugin) Stop() {
	if p.pool != nil {
		p.pool.Close()
	}
}

func (p *PostgresPlugin) Collect(ctx context.Context, action map[string]interface{}) (float64, error) {
	if p.pool == nil {
		return 0, errPluginNotConfigured("postgres")
	}
	actionName, _ := action["action"].(string)

	switch actionName {
	case "ping":
		if err := p.pool.Ping(ctx); err != nil {
			return 0, nil // ping başarısız -- hata değil, "0" (down) değeri anlamlı bir metrik
		}
		return 1, nil

	case "connections":
		var count int
		if err := p.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity`).Scan(&count); err != nil {
			return 0, fmt.Errorf("bağlantı sayısı alınamadı: %w", err)
		}
		return float64(count), nil

	case "uptime":
		var seconds float64
		if err := p.pool.QueryRow(ctx, `SELECT extract(epoch from (now() - pg_postmaster_start_time()))`).Scan(&seconds); err != nil {
			return 0, fmt.Errorf("uptime alınamadı: %w", err)
		}
		return seconds, nil

	case "locks":
		var count int
		if err := p.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks`).Scan(&count); err != nil {
			return 0, fmt.Errorf("kilit sayısı alınamadı: %w", err)
		}
		return float64(count), nil

	default:
		return 0, fmt.Errorf("bilinmeyen postgres action: %s", actionName)
	}
}
