package main

import (
	"context"
	"fmt"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
)

// DockerPlugin, Docker daemon'una KALICI bir bağlantı (Unix socket ya da TCP) tutarak
// container/image sayısı ve ping durumu gibi temel metrikleri toplar. Zabbix Agent2'nin
// docker.* key'lerinin ilk (en sık kullanılan) alt kümesini kapsar.
type DockerPlugin struct {
	cli      *client.Client
	endpoint string
}

func init() {
	RegisterPlugin(&DockerPlugin{})
}

func (p *DockerPlugin) Name() string { return "docker" }

func (p *DockerPlugin) Configure(config map[string]interface{}) error {
	endpoint, _ := config["endpoint"].(string)
	if endpoint == "" {
		endpoint = "unix:///var/run/docker.sock" // Zabbix Agent2'nin varsayılanıyla aynı
	}
	p.endpoint = endpoint
	return nil
}

func (p *DockerPlugin) Start() error {
	cli, err := client.NewClientWithOpts(
		client.WithHost(p.endpoint),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return fmt.Errorf("docker client oluşturulamadı: %w", err)
	}
	// Bağlantıyı gerçekten doğrula -- NewClientWithOpts başarılı dönse bile daemon'a
	// hiç erişilemeyebilir (yanlış socket yolu, izin sorunu vb.).
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := cli.Ping(ctx); err != nil {
		cli.Close()
		return fmt.Errorf("docker daemon'a ping atılamadı: %w", err)
	}
	p.cli = cli
	return nil
}

func (p *DockerPlugin) Stop() {
	if p.cli != nil {
		p.cli.Close()
	}
}

func (p *DockerPlugin) Collect(ctx context.Context, action map[string]interface{}) (float64, error) {
	if p.cli == nil {
		return 0, errPluginNotConfigured("docker")
	}
	actionName, _ := action["action"].(string)

	switch actionName {
	case "ping":
		if _, err := p.cli.Ping(ctx); err != nil {
			return 0, nil // ping başarısız -- hata değil, "0" (down) değeri anlamlı bir metrik
		}
		return 1, nil

	case "container_count":
		state, _ := action["state"].(string) // "running" (varsayılan) ya da "all"
		containers, err := p.cli.ContainerList(ctx, container.ListOptions{All: state == "all"})
		if err != nil {
			return 0, fmt.Errorf("container listesi alınamadı: %w", err)
		}
		if state == "all" {
			return float64(len(containers)), nil
		}
		count := 0
		for _, c := range containers {
			if c.State == "running" {
				count++
			}
		}
		return float64(count), nil

	case "image_count":
		images, err := p.cli.ImageList(ctx, image.ListOptions{})
		if err != nil {
			return 0, fmt.Errorf("image listesi alınamadı: %w", err)
		}
		return float64(len(images)), nil

	default:
		return 0, fmt.Errorf("bilinmeyen docker action: %s", actionName)
	}
}
