package main

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// unsafeCharsPattern, komut enjeksiyonuna yol açabilecek shell özel karakterlerini
// tespit eder. UnsafeUserParameters=false (varsayılan) iken bu karakterleri içeren
// komutlar çalıştırılmadan reddedilir — Zabbix'in aynı isimli güvenlik varsayılanı.
var unsafeCharsPattern = regexp.MustCompile("[;&|`$()<>\\\\\n]")

// runUserParameters, config'te tanımlı her özel komutu çalıştırıp çıktısını sayıya
// çevirerek metrik listesine ekler. Güvenli olmayan komutlar (varsayılan ayarla)
// çalıştırılmadan atlanır ve loglanır.
func runUserParameters(cfg *Config) []metricPayload {
	var results []metricPayload

	for _, up := range cfg.UserParameters {
		if !cfg.UnsafeUserParameters && unsafeCharsPattern.MatchString(up.Command) {
			logf("[UserParameter] %s: komut güvensiz karakterler içeriyor, çalıştırılmadı (unsafe_user_parameters:true ile açılabilir)", up.MetricName)
			continue
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		output, err := exec.CommandContext(ctx, "sh", "-c", up.Command).Output()
		cancel()
		if err != nil {
			logf("[UserParameter] %s: komut hatası - %v", up.MetricName, err)
			continue
		}

		value, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
		if err != nil {
			logf("[UserParameter] %s: çıktı sayıya çevrilemedi (\"%s\")", up.MetricName, strings.TrimSpace(string(output)))
			continue
		}

		results = append(results, metricPayload{MetricName: up.MetricName, Value: value})
	}

	return results
}
