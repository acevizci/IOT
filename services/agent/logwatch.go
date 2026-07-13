package main

import (
	"bufio"
	"os"
	"regexp"
)

// logOffsets, her log dosyası için son okunan byte pozisyonunu saklar (tail benzeri
// davranış — dosyanın başından her seferinde okumayız, sadece yeni eklenen kısmı).
var logOffsets = map[string]int64{}

// runLogWatches, her tanımlı log dosyasında, son kontrolden bu yana eklenen satırları
// okuyup verilen regex desenine uyanları sayar. MaxLinesPerSecond ile sınırlıdır —
// bir log patlaması (aniden binlerce satır) durumunda metrik selini önler.
func runLogWatches(cfg *Config) []metricPayload {
	var results []metricPayload

	for _, lw := range cfg.LogWatches {
		pattern, err := regexp.Compile(lw.Pattern)
		if err != nil {
			logf("[LogWatch] %s: regex geçersiz (\"%s\"): %v", lw.MetricName, lw.Pattern, err)
			continue
		}

		file, err := os.Open(lw.FilePath)
		if err != nil {
			logf("[LogWatch] %s: dosya açılamadı (\"%s\"): %v", lw.MetricName, lw.FilePath, err)
			continue
		}

		offset := logOffsets[lw.FilePath]
		stat, statErr := file.Stat()
		if statErr == nil && stat.Size() < offset {
			offset = 0 // dosya döndürülmüş (log rotation) — baştan başla
		}
		file.Seek(offset, 0)

		scanner := bufio.NewScanner(file)
		maxLines := cfg.MaxLinesPerSecond * int(cfg.MetricsSeconds) // bir kontrol döngüsü için toplam limit
		matchCount := 0
		linesRead := 0
		for scanner.Scan() && linesRead < maxLines {
			linesRead++
			if pattern.MatchString(scanner.Text()) {
				matchCount++
			}
		}
		if linesRead >= maxLines {
			logf("[LogWatch] %s: MaxLinesPerSecond sınırına ulaşıldı (%d satır), bir sonraki döngüde devam edilecek", lw.MetricName, maxLines)
		}

		newOffset, _ := file.Seek(0, 1) // mevcut pozisyon (io.SeekCurrent)
		logOffsets[lw.FilePath] = newOffset
		file.Close()

		results = append(results, metricPayload{MetricName: lw.MetricName, Value: float64(matchCount)})
	}

	return results
}
