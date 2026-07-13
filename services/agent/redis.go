package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisPlugin, Redis'e KALICI bir client tutarak (go-redis üzerinden) bağlı istemci
// sayısı/bellek kullanımı/çalışma-süresi gibi temel sağlık metriklerini toplar.
// Zabbix Agent2'nin redis.* key'lerinin ilk (en sık kullanılan) alt kümesini kapsar.
type RedisPlugin struct {
	client  *redis.Client
	address string
}

func init() {
	RegisterPlugin(&RedisPlugin{})
}

func (p *RedisPlugin) Name() string { return "redis" }

func (p *RedisPlugin) Configure(config map[string]interface{}) error {
	address, _ := config["address"].(string)
	if address == "" {
		address = "localhost:6379" // Redis'in kendi varsayılan portu
	}
	p.address = address
	return nil
}

func (p *RedisPlugin) Start() error {
	client := redis.NewClient(&redis.Options{Addr: p.address})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Bağlantıyı gerçekten doğrula -- NewClient hiçbir zaman hata dönmez (lazy connect),
	// sunucuya hiç erişilemeyebilir (yanlış adres/port).
	if err := client.Ping(ctx).Err(); err != nil {
		client.Close()
		return fmt.Errorf("redis'e ping atılamadı: %w", err)
	}
	p.client = client
	return nil
}

func (p *RedisPlugin) Stop() {
	if p.client != nil {
		p.client.Close()
	}
}

// parseInfoField, Redis'in INFO komutunun döndürdüğü "key:value\r\n" formatındaki
// çıktısından tek bir alanı sayısal olarak çıkarır.
func parseInfoField(info string, field string) (float64, error) {
	for _, line := range strings.Split(info, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, field+":") {
			raw := strings.TrimPrefix(line, field+":")
			value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
			if err != nil {
				return 0, fmt.Errorf("INFO alanı '%s' sayısal değil: %w", field, err)
			}
			return value, nil
		}
	}
	return 0, fmt.Errorf("INFO çıktısında '%s' alanı bulunamadı", field)
}

func (p *RedisPlugin) Collect(ctx context.Context, action map[string]interface{}) (float64, error) {
	if p.client == nil {
		return 0, errPluginNotConfigured("redis")
	}
	actionName, _ := action["action"].(string)

	switch actionName {
	case "ping":
		if err := p.client.Ping(ctx).Err(); err != nil {
			return 0, nil // ping başarısız -- hata değil, "0" (down) değeri anlamlı bir metrik
		}
		return 1, nil

	case "connected_clients":
		info, err := p.client.Info(ctx, "clients").Result()
		if err != nil {
			return 0, fmt.Errorf("INFO clients alınamadı: %w", err)
		}
		return parseInfoField(info, "connected_clients")

	case "used_memory":
		info, err := p.client.Info(ctx, "memory").Result()
		if err != nil {
			return 0, fmt.Errorf("INFO memory alınamadı: %w", err)
		}
		return parseInfoField(info, "used_memory")

	case "uptime_in_seconds":
		info, err := p.client.Info(ctx, "server").Result()
		if err != nil {
			return 0, fmt.Errorf("INFO server alınamadı: %w", err)
		}
		return parseInfoField(info, "uptime_in_seconds")

	case "slowlog_count":
		count, err := p.client.SlowLogLen(ctx).Result()
		if err != nil {
			return 0, fmt.Errorf("slowlog uzunluğu alınamadı: %w", err)
		}
		return float64(count), nil

	default:
		return 0, fmt.Errorf("bilinmeyen redis action: %s", actionName)
	}
}
