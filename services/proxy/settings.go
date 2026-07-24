package main

import "sync"

// Settings, config-pull döngüsüyle (bkz. configpull.go) canlı olarak güncellenen,
// birden fazla goroutine (HTTP handler'lar, heartbeat/flush döngüleri) tarafından
// okunan paylaşılan ayarları taşır -- Dashboard'dan değiştirilen bir aralık, proxy'yi
// yeniden başlatmadan bir sonraki config-pull turunda devreye girer.
type Settings struct {
	mu                  sync.RWMutex
	heartbeatSeconds    int
	metricsFlushSeconds int
	queueRetentionLimit int
}

func NewSettings(cfg *Config) *Settings {
	return &Settings{
		heartbeatSeconds:    cfg.HeartbeatSeconds,
		metricsFlushSeconds: cfg.MetricsFlushSeconds,
		queueRetentionLimit: cfg.QueueRetentionLimit,
	}
}

func (s *Settings) Snapshot() (heartbeatSeconds, metricsFlushSeconds, queueRetentionLimit int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.heartbeatSeconds, s.metricsFlushSeconds, s.queueRetentionLimit
}

// Update, core'dan çekilen /api/v1/proxy/config yanıtını uygular. 0 değerler yok
// sayılır (core'un o alanı hiç döndürmediği ya da geçici bir hata durumu -- mevcut
// ayar korunur, asla anlamsız bir değere sıfırlanmaz).
func (s *Settings) Update(heartbeatSeconds, metricsFlushSeconds, queueRetentionLimit int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if heartbeatSeconds > 0 {
		s.heartbeatSeconds = heartbeatSeconds
	}
	if metricsFlushSeconds > 0 {
		s.metricsFlushSeconds = metricsFlushSeconds
	}
	if queueRetentionLimit > 0 {
		s.queueRetentionLimit = queueRetentionLimit
	}
}
