package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Plugin, Zabbix Agent2'nin plugin mimarisinin bizim mimarimize uyarlanmış hali —
// UserParameter'ın aksine (her çağrıda yeni process başlatan, kırılgan bir çözüm),
// her plugin KALICI bir bağlantı (Docker socket, DB pool, Redis client) tutar ve
// bu bağlantı üzerinden Collect() çağrılarını işler.
type Plugin interface {
	Name() string                                                  // "docker", "postgres", "redis", "perfcounter", "wmi"
	Configure(config map[string]interface{}) error                 // agent_config.json'daki plugins.<Name> bölümünü alır
	Start() error                                                  // kalıcı bağlantıyı kurar
	Stop()                                                         // bağlantıyı temiz kapatır
	Collect(ctx context.Context, action map[string]interface{}) (float64, error) // TEK bir item'ı işler
}

// registeredPlugins, her plugin dosyasının kendi init()'inde doldurduğu kayıt —
// Agent2'nin "plugin'ler binary'ye statik derlenir" ilkesiyle aynı (dinamik .so yükleme yok).
var registeredPlugins = map[string]Plugin{}

func RegisterPlugin(p Plugin) {
	registeredPlugins[p.Name()] = p
}

// startedPlugins, Configure+Start() başarıyla tamamlanmış plugin'leri tutar —
// sadece config'te gerçekten ayarı olan plugin'ler başlatılır (örn. Docker kurulu
// değilse, docker plugin'i hiç Start() çağrılmaz).
var startedPlugins = map[string]Plugin{}

// initPlugins, config'teki "plugins" bölümünde tanımlı her plugin'i Configure+Start eder.
// Bir plugin başlatılamazsa (örn. Docker socket'e erişilemiyor), agent ÇÖKMEZ — sadece
// o plugin'e bağlı item'lar hiç veri üretmez, hata loglanır.
func initPlugins(cfg *Config) {
	for name, pluginConfig := range cfg.Plugins {
		plugin, exists := registeredPlugins[name]
		if !exists {
			logf("[Plugin] Bilinmeyen plugin adı config'te tanımlı: %s", name)
			continue
		}
		if err := plugin.Configure(pluginConfig); err != nil {
			logf("[Plugin] %s yapılandırılamadı: %v", name, err)
			continue
		}
		if err := plugin.Start(); err != nil {
			logf("[Plugin] %s başlatılamadı (bağlantı kurulamadı): %v", name, err)
			continue
		}
		startedPlugins[name] = plugin
		logf("[Plugin] %s başarıyla başlatıldı", name)
	}
}

// stopPlugins, program kapanırken tüm açık plugin bağlantılarını temiz kapatır.
func stopPlugins() {
	for name, plugin := range startedPlugins {
		plugin.Stop()
		logf("[Plugin] %s kapatıldı", name)
	}
}

// collectPluginMetrics, sunucudan senkronize edilen item listesindeki (itemsync.go)
// "connection_config.plugin" alanı dolu olan item'ları ilgili plugin'e yönlendirir.
func collectPluginMetrics() []metricPayload {
	serverItemsMu.RLock()
	items := serverItems
	serverItemsMu.RUnlock()

	var results []metricPayload
	for _, item := range items {
		pluginName, ok := item.ConnectionConfig["plugin"].(string)
		if !ok || pluginName == "" {
			continue // bu item plugin'e değil, başka bir mekanizmaya (proc.num vb.) ait
		}

		plugin, started := startedPlugins[pluginName]
		if !started {
			continue // plugin config'te tanımlı değil ya da başlatılamadı — sessizce atla, zaten loglandı
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		value, err := plugin.Collect(ctx, item.ConnectionConfig)
		cancel()
		if err != nil {
			logf("[Plugin] %s: %s toplama hatası: %v", pluginName, item.MetricName, err)
			continue
		}
		results = append(results, metricPayload{MetricName: item.MetricName, Value: value})
	}
	return results
}

// errPluginNotConfigured, henüz Start() edilmemiş bir plugin'e Collect çağrısı
// yapılırsa dönen standart hata.
func errPluginNotConfigured(name string) error {
	return fmt.Errorf("plugin '%s' henüz başlatılmadı", name)
}

// Faz G: agent'in Docker/PostgreSQL/Redis plugin'lerinin baglanti bilgisini (endpoint/
// uri/adres) SUNUCUDAN periyodik cekmesini saglar -- item senkronizasyonuyla
// (itemsync.go/syncServerItems) AYNI PSK deseninde. Onceki senkronizasyona gore
// DEGISIKLIK varsa, mevcut plugin'ler durdurulup YENI config ile yeniden baslatilir --
// boylece kullanici dashboard'dan bir ayari degistirdiginde, agent'i elle yeniden
// baslatmaya gerek kalmadan bir sonraki senkronizasyon dongusunde etkili olur.
var lastPluginConfigJSON string

func syncPluginConfig(cfg *Config) {
	url := cfg.ServerURL + "/api/v1/agent/plugin-config?device_id=" + cfg.DeviceID + "&psk=" + cfg.PSK
	resp, err := httpClient.Get(url)
	if err != nil {
		logf("[Plugin] Sunucudan plugin config çekilemedi: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		logf("[Plugin] Plugin config isteği reddedildi (%d)", resp.StatusCode)
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logf("[Plugin] Plugin config yanıtı okunamadı: %v", err)
		return
	}

	newJSON := string(body)
	if newJSON == lastPluginConfigJSON {
		return // değişiklik yok, yeniden başlatmaya gerek yok
	}

	var newPlugins map[string]map[string]interface{}
	if err := json.Unmarshal(body, &newPlugins); err != nil {
		logf("[Plugin] Plugin config çözülemedi: %v", err)
		return
	}

	logf("[Plugin] Sunucudan yeni plugin config alındı, plugin'ler yeniden başlatılıyor...")
	stopPlugins()
	cfg.Plugins = newPlugins
	initPlugins(cfg)
	lastPluginConfigJSON = newJSON
}

