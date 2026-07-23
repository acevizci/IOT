//go:build windows

package main

import (
	"context"
	"fmt"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// PerfCounterPlugin, Windows Performance Counter (PDH) API'sine KALICI bir query
// tutarak sayaç değerlerini toplar. Zabbix Agent2'nin perf_counter_en key'inin
// karşılığı -- 44 template'teki en büyük tekil kategori (26 item).
//
// PDH'nin gerçek davranışı gereği: RATE tipi sayaçlar (örn. "% Processor Time")
// için DOĞRU değer almak, aynı counter üzerinde EN AZ İKİ ardışık PdhCollectQueryData
// çağrısı gerektirir (ilk çağrı sadece bir "temel" örnek alır, ikinci çağrı aradaki
// farktan oranı hesaplar). Bu yüzden query + tüm counter handle'ları KALICI tutulur,
// her Collect() çağrısında AYNI query üzerinde yeniden toplama yapılır -- bir counter
// ilk eklendiğinde dönen "henüz veri yok" durumu hata değil, beklenen bir durumdur.
//
// GERÇEK HATA DÜZELTMESİ (canlı testte bulundu -- win_cpu_percent hep 100/0
// arası zıplıyordu): collectPluginMetrics() (plugin.go) bu plugin'e bağlı HER
// item için AYRI AYRI Collect() çağırıyor (örn. 27 item, aynı ~60sn'lik turda
// art arda). PdhCollectQueryData PAYLAŞILAN sorgudaki TÜM sayaçları birden
// yeniliyor -- yani her Collect() çağrısı, bir önceki item'ın çağrısından
// SADECE MİKROSANİYELER sonra sorguyu tekrar yeniliyordu. RATE tipi bir sayaç
// için "iki örnek arası fark" mikrosaniyelik bir pencereden hesaplanınca sonuç
// neredeyse rastgele oluyor (0, 100 ya da aradaki herhangi bir değer). Çözüm:
// PdhCollectQueryData'yı item başına değil, TUR BAŞINA bir kez çalıştır --
// lastRefresh ile "yeterince yakın zamanda yenilendiyse tekrar yenileme" kontrolü.
const perfCounterRefreshThreshold = time.Second

type PerfCounterPlugin struct {
	query       pdhQueryHandle
	mu          sync.Mutex
	counters    map[string]pdhCounterHandle
	lastRefresh time.Time
}

func init() {
	RegisterPlugin(&PerfCounterPlugin{})
}

func (p *PerfCounterPlugin) Name() string { return "perfcounter" }

func (p *PerfCounterPlugin) Configure(config map[string]interface{}) error {
	return nil // bu plugin'in kalıcı bir config'i yok -- her counter path Collect() anında gelir
}

func (p *PerfCounterPlugin) Start() error {
	var query pdhQueryHandle
	ret, _, _ := procPdhOpenQueryW.Call(0, 0, uintptr(unsafe.Pointer(&query)))
	if ret != 0 {
		return fmt.Errorf("PdhOpenQueryW başarısız (kod: 0x%X)", ret)
	}
	p.query = query
	p.counters = make(map[string]pdhCounterHandle)
	return nil
}

func (p *PerfCounterPlugin) Stop() {
	if p.query != 0 {
		procPdhCloseQuery.Call(uintptr(p.query))
	}
}

func (p *PerfCounterPlugin) Collect(ctx context.Context, action map[string]interface{}) (float64, error) {
	if p.query == 0 {
		return 0, errPluginNotConfigured("perfcounter")
	}
	path, _ := action["path"].(string)
	if path == "" {
		return 0, fmt.Errorf(`perfcounter action'ında 'path' zorunlu (örn. \Processor(_Total)\%% Processor Time)`)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	counter, exists := p.counters[path]
	if !exists {
		pathPtr, err := syscall.UTF16PtrFromString(path)
		if err != nil {
			return 0, fmt.Errorf("counter path UTF16'ya çevrilemedi: %w", err)
		}
		ret, _, _ := procPdhAddEnglishCounterW.Call(uintptr(p.query), uintptr(unsafe.Pointer(pathPtr)), 0, uintptr(unsafe.Pointer(&counter)))
		if ret != 0 {
			return 0, fmt.Errorf("counter eklenemedi ('%s'): kod 0x%X", path, ret)
		}
		p.counters[path] = counter
	}

	// Bu tur içinde (aynı ~60sn'lik döngüde) başka bir item için zaten
	// yenilendiyse tekrar yenileme -- aksi halde her item'ın Collect()'i
	// birbirini mikrosaniyeler arayla ezip RATE sayaçlarını bozuyordu.
	var ret uintptr
	if time.Since(p.lastRefresh) >= perfCounterRefreshThreshold {
		ret, _, _ = procPdhCollectQueryData.Call(uintptr(p.query))
		if ret != 0 {
			return 0, fmt.Errorf("PdhCollectQueryData başarısız: kod 0x%X", ret)
		}
		p.lastRefresh = time.Now()
	}

	var value pdhFmtCounterValueDouble
	var counterType uint32
	ret, _, _ = procPdhGetFormattedCounterValue.Call(
		uintptr(counter),
		uintptr(pdhFmtDouble),
		uintptr(unsafe.Pointer(&counterType)),
		uintptr(unsafe.Pointer(&value)),
	)
	if ret != 0 {
		// PDH_CSTATUS_INVALID_DATA -- rate sayaçlarında İLK örnekte beklenen bir
		// durum (henüz iki ardışık toplama yapılmadı), hata değil.
		return 0, nil
	}

	return value.DoubleValue, nil
}

type pdhQueryHandle uintptr
type pdhCounterHandle uintptr

// pdhFmtCounterValueDouble, PDH_FMT_COUNTERVALUE'nun "double" alanını okuyan Go
// karşılığı -- CStatus (4 bayt) + hizalama dolgusu (4 bayt) + union'ın en büyük üyesi
// kadar (8 bayt, double/LONGLONG) alan kaplıyor, MSDN'deki gerçek struct layout'uyla eşleşir.
type pdhFmtCounterValueDouble struct {
	CStatus     uint32
	_           uint32
	DoubleValue float64
}

const pdhFmtDouble = 0x00000200

var (
	pdhDLL            = syscall.NewLazyDLL("pdh.dll")
	procPdhOpenQueryW = pdhDLL.NewProc("PdhOpenQueryW")
	// GERCEK HATA DUZELTMESI (canli Windows testinde bulundu): PdhAddCounterW,
	// sayaç yolundaki nesne/sayaç adlarını (örn. "Processor") SISTEMIN DIL AYARINA
	// göre yerelleştirilmiş olarak yorumluyor -- Türkçe bir Windows'ta "Processor"
	// nesnesi bulunamadı (PDH_CSTATUS_NO_OBJECT, 0xC0000BB8). PdhAddEnglishCounterW
	// ise sayaç yolunu HER ZAMAN İngilizce (dilden bağımsız) olarak yorumlar --
	// path'lerimizi hep İngilizce yazdığımız için (örn. "\Processor(_Total)\...")
	// doğru fonksiyon bu, PdhAddCounterW değil.
	procPdhAddEnglishCounterW       = pdhDLL.NewProc("PdhAddEnglishCounterW")
	procPdhCollectQueryData         = pdhDLL.NewProc("PdhCollectQueryData")
	procPdhGetFormattedCounterValue = pdhDLL.NewProc("PdhGetFormattedCounterValue")
	procPdhCloseQuery               = pdhDLL.NewProc("PdhCloseQuery")
)
