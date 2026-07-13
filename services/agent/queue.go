package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const queueDir = "agent_queue"
const maxQueueFiles = 500 // Zabbix'in BufferSize deseni — sınırsız disk büyümesini önler

type queuedBatch struct {
	AgentVersion string          `json:"agent_version"`
	Metrics      []metricPayload `json:"metrics"`
}

// enqueueBatch, sunucuya ulaşılamadığında bir metrik setini diske yazar — veri kaybı
// olmaz, bağlantı geri gelince gönderilir (Zabbix'in BufferSend/BufferSize deseni).
func enqueueBatch(metrics []metricPayload, agentVersion string) error {
	if err := os.MkdirAll(queueDir, 0700); err != nil {
		return err
	}

	entries, _ := os.ReadDir(queueDir)
	if len(entries) >= maxQueueFiles {
		// En eski dosyayı at (FIFO) — sınırsız disk büyümesini önle, uyarı ver.
		oldest := oldestQueueFile(entries)
		if oldest != "" {
			log.Printf("[Agent] Kuyruk dolu (%d dosya), en eski kayıt atılıyor: %s\n", len(entries), oldest)
			os.Remove(filepath.Join(queueDir, oldest))
		}
	}

	batch := queuedBatch{AgentVersion: agentVersion, Metrics: metrics}
	data, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	filename := filepath.Join(queueDir, time.Now().Format("20060102T150405.000000000")+".json")
	return os.WriteFile(filename, data, 0600)
}

func oldestQueueFile(entries []os.DirEntry) string {
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names) // dosya adları zaman damgası olduğu için alfabetik sıralama = kronolojik
	if len(names) == 0 {
		return ""
	}
	return names[0]
}

// flushQueue, biriken tüm kuyruk dosyalarını sunucuya göndermeyi dener — en eskiden
// başlayarak (sıra korunur). Bir dosya gönderilemezse, kuyruğu daha fazla zorlamadan
// durur (sunucu hâlâ erişilemez olabilir, bir sonraki döngüde tekrar denenir).
func flushQueue(cfg *Config) {
	entries, err := os.ReadDir(queueDir)
	if err != nil {
		return // kuyruk dizini hiç yoksa (henüz hiç kayıp gönderim olmadıysa) sorun değil
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		path := filepath.Join(queueDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var batch queuedBatch
		if err := json.Unmarshal(data, &batch); err != nil {
			os.Remove(path) // bozuk dosya, kurtarılamaz — temizle
			continue
		}
		if err := sendMetrics(cfg, batch.Metrics, batch.AgentVersion); err != nil {
			log.Println("[Agent] Kuyruk gönderimi başarısız, sonraki döngüde tekrar denenecek:", err)
			return // bu döngüde daha fazla deneme yapma
		}
		os.Remove(path)
		log.Println("[Agent] Kuyruktan başarıyla gönderildi:", name)
	}
}
