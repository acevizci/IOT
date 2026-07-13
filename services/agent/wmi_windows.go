//go:build windows

package main

import (
	"context"
	"fmt"

	"github.com/yusufpapurcu/wmi"
)

// WMIPlugin, WMI (Windows Management Instrumentation) sorgularını çalıştırır.
// Zabbix Agent2'nin wmi.get/wmi.getall key'lerinin karşılığı. PDH'nin aksine WMI
// kalıcı bir bağlantı gerektirmez -- her sorgu kendi bağımsız COM çağrısıdır.
type WMIPlugin struct{}

func init() {
	RegisterPlugin(&WMIPlugin{})
}

func (p *WMIPlugin) Name() string { return "wmi" }

func (p *WMIPlugin) Configure(config map[string]interface{}) error { return nil }

func (p *WMIPlugin) Start() error { return nil }

func (p *WMIPlugin) Stop() {}

// wmiGenericResult, herhangi bir WMI sınıfından TEK bir sayısal alanı okumak için
// kullanılan genel bir kalıp -- sorgunun kendisi WQL "AS Value" ile hangi alanı
// istediğini belirtir, örn:
// "SELECT PercentProcessorTime AS Value FROM Win32_PerfFormattedData_PerfOS_Processor WHERE Name='_Total'"
type wmiGenericResult struct {
	Value float64
}

func (p *WMIPlugin) Collect(ctx context.Context, action map[string]interface{}) (float64, error) {
	query, _ := action["query"].(string)
	if query == "" {
		return 0, fmt.Errorf(`wmi action'ında 'query' zorunlu (sonuç alanı "AS Value" ile adlandırılmalı)`)
	}

	var results []wmiGenericResult
	if err := wmi.Query(query, &results); err != nil {
		return 0, fmt.Errorf("WMI sorgusu başarısız: %w", err)
	}
	if len(results) == 0 {
		return 0, fmt.Errorf("WMI sorgusu sonuç döndürmedi")
	}
	return results[0].Value, nil
}
