package main

import (
	"regexp"

	"github.com/shirou/gopsutil/v3/process"
)

// countProcessesByPattern, verilen regex desenine uyan process adına sahip çalışan
// process sayısını döner. Hem yerel config'teki ProcessWatches hem de sunucudan
// senkronize edilen proc.num tarzı item'lar (itemsync.go) tarafından ortak kullanılır.
func countProcessesByPattern(namePattern string) int {
	pattern, err := regexp.Compile(namePattern)
	if err != nil {
		logf("[ProcessWatch] Regex geçersiz (\"%s\"): %v", namePattern, err)
		return 0
	}

	processes, err := process.Processes()
	if err != nil {
		logf("[ProcessWatch] Process listesi alınamadı: %v", err)
		return 0
	}

	count := 0
	for _, p := range processes {
		name, err := p.Name()
		if err != nil {
			continue
		}
		if pattern.MatchString(name) {
			count++
		}
	}
	return count
}

// runProcessWatches, config.json'da tanımlı yerel process izlemelerini işler
// (Zabbix'in proc.num[] item'ının, kullanıcının kendi tanımladığı karşılığı).
func runProcessWatches(cfg *Config) []metricPayload {
	var results []metricPayload
	for _, pw := range cfg.ProcessWatches {
		count := countProcessesByPattern(pw.NamePattern)
		results = append(results, metricPayload{MetricName: pw.MetricName, Value: float64(count)})
	}
	return results
}
