//go:build windows

package main

import (
	"context"
	"fmt"
	"reflect"
	"strings"

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

// Collect, action'da AYRI olarak verilen "query" (ham WQL, alias İÇERMEMELİ -- WQL,
// SQL'in aksine "AS" alias sözdizimini DESTEKLEMEZ; gerçek Windows'ta canlı test
// edilirken "SELECT X AS Value FROM ..." tarzı bir sorgu "Invalid query" hatasıyla
// reddedildi, bu da bu plugin'in ilk sürümündeki yanlış bir tasarım varsayımıydı) ve
// "field" (okunacak GERÇEK WMI özellik adı, örn. "FreePhysicalMemory") ile çalışır.
// reflect.StructOf ile çalışma zamanında TEK alanlı bir struct oluşturup, wmi
// kütüphanesinin bu alana o WMI özelliğini yazmasını sağlıyoruz -- derleme zamanında
// hangi alanın isteneceğini bilemeyeceğimiz için (her item farklı bir özellik ister)
// sabit bir struct tanımlamak mümkün değil.
func (p *WMIPlugin) Collect(ctx context.Context, action map[string]interface{}) (float64, error) {
	query, _ := action["query"].(string)
	field, _ := action["field"].(string)
	if query == "" || field == "" {
		return 0, fmt.Errorf(`wmi action'ında 'query' (ham WQL, "AS" alias'ı OLMADAN) ve 'field' (okunacak gerçek WMI özellik adı) ikisi de zorunlu`)
	}

	goFieldName := strings.ToUpper(field[:1]) + field[1:] // Go struct alanı export edilmeli (büyük harfle başlamalı)
	// GERCEK HATA DUZELTMESI (canli Windows testinde IKI turda bulundu): (1) float64
	// struct alani kullaninca sorgu HATASIZ donuyordu ama deger SESSIZCE 0 kaliyordu;
	// (2) interface{} struct alani DAHA KOTU davrandi, kutuphane bu alani HIC
	// doldurmuyor (nil kaliyor) -- yani yusufpapurcu/wmi, reflect.Interface Kind'ini
	// hic desteklemiyor. WMI'nin coğu sayisal ozelligi (orn. FreePhysicalMemory)
	// gercekte uint64 COM VARIANT tipinde donuyor (MSDN semasina gore) -- struct
	// alanini doğrudan bu somut tipte tanimliyoruz, en yaygin WMI sayisal tipi bu.
	structType := reflect.StructOf([]reflect.StructField{
		{Name: goFieldName, Type: reflect.TypeOf(uint64(0)), Tag: reflect.StructTag(`wmi:"` + field + `"`)},
	})
	resultsPtr := reflect.New(reflect.SliceOf(structType))

	if err := wmi.Query(query, resultsPtr.Interface()); err != nil {
		return 0, fmt.Errorf("WMI sorgusu başarısız: %w", err)
	}

	results := resultsPtr.Elem()
	if results.Len() == 0 {
		return 0, fmt.Errorf("WMI sorgusu sonuç döndürmedi")
	}

	return float64(results.Index(0).Field(0).Uint()), nil
}
