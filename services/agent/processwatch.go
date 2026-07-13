package main

import (
	"regexp"

	"github.com/shirou/gopsutil/v3/process"
)

// runProcessWatches, her tanımlı desen için, o desenle eşleşen process adına sahip
// çalışan process sayısını metrik olarak döner (Zabbix'in proc.num[] item'ının karşılığı).
func runProcessWatches(cfg *Config) []metricPayload {
	var results []metricPayload
	if len(cfg.ProcessWatches) == 0 {
		return results
	}

	processes, err := process.Processes()
	if err != nil {
		logf("[ProcessWatch] Process listesi alınamadı: %v", err)
		return results
	}

	for _, pw := range cfg.ProcessWatches {
		pattern, err := regexp.Compile(pw.NamePattern)
		if err != nil {
			logf("[ProcessWatch] %s: regex geçersiz (\"%s\"): %v", pw.MetricName, pw.NamePattern, err)
			continue
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
		results = append(results, metricPayload{MetricName: pw.MetricName, Value: float64(count)})
	}

	return results
}
