package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	psnet "github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// GERÇEK EKSİKLİK DÜZELTMESİ (RAM/disk/CPU/ethernet incelemesi, endüstri
// standardı): agent hiç ağ trafiği toplamıyordu -- SADECE SNMP ile izlenen
// cihazlarda ağ görünürlüğü vardı, agent'la (SNMP'siz) izlenen bir sunucuda
// sıfırdı. Aynı zamanda disk I/O (okuma/yazma HIZI, sadece doluluk % değil)
// de hiç yoktu. npm-service'teki computeInterfaceRate ile AYNI mantık --
// collectMetrics() tek bir goroutine'den, periyodik olarak çağrıldığı için
// (main.go'nun ana döngüsü) kilit gerekmiyor.
type counterSample struct {
	value       uint64
	timestampMs int64
}

var counterRateCache = map[string]counterSample{}

// Negatif delta (sayaç sıfırlanması/servis yeniden başlatması) durumunda nil
// döner -- gopsutil'in sayaçları 64-bit, gerçek dünyada sarılması yüzyıllar
// sürer, bu yüzden (SNMP'nin 32-bit sayaçlarının aksine) sarılma düzeltmesi
// gerekmez.
func computeCounterRate(key string, value uint64, now time.Time) (float64, bool) {
	nowMs := now.UnixMilli()
	prev, exists := counterRateCache[key]
	counterRateCache[key] = counterSample{value: value, timestampMs: nowMs}
	if !exists || value < prev.value {
		return 0, false
	}
	dtSeconds := float64(nowMs-prev.timestampMs) / 1000
	if dtSeconds <= 0 {
		return 0, false
	}
	return float64(value-prev.value) / dtSeconds, true
}

// collectMetrics, MVP kapsamındaki temel OS metriklerini toplar.
func collectMetrics() []metricPayload {
	var metrics []metricPayload

	if percentages, err := cpu.Percent(0, false); err == nil && len(percentages) > 0 {
		metrics = append(metrics, metricPayload{MetricName: "cpu_util", Value: percentages[0], Unit: "%"})
	}
	if vmStat, err := mem.VirtualMemory(); err == nil {
		metrics = append(metrics, metricPayload{MetricName: "memory_used_percent", Value: vmStat.UsedPercent, Unit: "%"})
		// vm.memory.size[available]/[total] trigger'ları YÜZDE değil HAM BAYT bekliyor --
		// bunları memory_used_percent'e eşlemek anlamsal olarak yanlıştı (bulundu, düzeltildi).
		metrics = append(metrics, metricPayload{MetricName: "memory_available_bytes", Value: float64(vmStat.Available), Unit: "B"})
		metrics = append(metrics, metricPayload{MetricName: "memory_total_bytes", Value: float64(vmStat.Total), Unit: "B"})
	}
	if partitions, err := disk.Partitions(false); err == nil {
		for _, p := range partitions {
			usage, err := disk.Usage(p.Mountpoint)
			if err != nil {
				// GERÇEK HATA DÜZELTMESİ (canlı veride bulundu): bu hata daha önce
				// TAMAMEN sessizce yutuluyordu -- bir disk 2 gün boyunca hiç
				// raporlamayı kesse bile agent loglarında HİÇBİR iz kalmıyordu.
				logf("[Collector] disk kullanım bilgisi alınamadı (%s): %v", p.Mountpoint, err)
				continue
			}
			// GERÇEK HATA DÜZELTMESİ (canlı veride bulundu): Windows'ta gopsutil
			// PartitionStat.Mountpoint BOŞ dönüyor (Linux'taki POSIX mount point
			// kavramının Windows'ta karşılığı yok) -- bu yüzden BİRDEN FAZLA disk
			// (örn. C: ve D:) sunucuda AYNI (boş) interface etiketiyle görünüyordu,
			// birbirinden ayırt edilemiyorlardı (aynı anda gelen farklı değerler
			// tek bir "instance" gibi görünüyordu). Device (sürücü harfi/yolu) her
			// zaman dolu, Mountpoint boşsa ona düşülüyor.
			iface := p.Mountpoint
			if iface == "" {
				iface = p.Device
			}
			metrics = append(metrics, metricPayload{
				MetricName: "disk_used_percent", Value: usage.UsedPercent, Unit: "%", Interface: iface,
			})
			// EKSİKLİK DÜZELTMESİ: vfs.fs.inode[,pfree] karşılığı hiç yoktu --
			// bir dosya sistemi disk alanı dolu olmadan da inode tükenmesiyle
			// "disk doldu" hatası verebilir (özellikle çok sayıda küçük dosya
			// olan sistemlerde), bu tamamen görünmezdi. Windows'ta InodesTotal
			// 0 döner (NTFS'te kavram yok) -- bu durumda metrik hiç gönderilmez.
			if usage.InodesTotal > 0 {
				metrics = append(metrics, metricPayload{
					MetricName: "disk_inodes_used_percent", Value: usage.InodesUsedPercent, Unit: "%", Interface: iface,
				})
			}
		}
	} else {
		logf("[Collector] disk bölümleri listelenemedi, disk_used_percent bu turda hiç gönderilmedi: %v", err)
	}
	if uptime, err := host.Uptime(); err == nil {
		metrics = append(metrics, metricPayload{MetricName: "system_uptime", Value: float64(uptime), Unit: "s"})
	}

	// system.swap.size[,pfree] / system.swap.size[,total] (Linux) ve system.swap.pfree
	// (Windows) trigger'larının karşılığı -- ikisi de aynı gopsutil çağrısıyla.
	if swapStat, err := mem.SwapMemory(); err == nil {
		pfree := 100.0
		if swapStat.Total > 0 {
			pfree = float64(swapStat.Free) / float64(swapStat.Total) * 100
		}
		metrics = append(metrics, metricPayload{MetricName: "system_swap_size_pfree", Value: pfree, Unit: "%"})
		metrics = append(metrics, metricPayload{MetricName: "system_swap_size_total", Value: float64(swapStat.Total), Unit: "B"})
	}

	// system.cpu.load[all,avg1] -- geleneksel olarak SADECE Linux/macOS'ta
	// anlamlıydı. DÜZELTME (canlı veride bulundu): bu yorum artık GÜNCEL DEĞİL --
	// güncel gopsutil sürümleri Windows'ta da işlemci kuyruğu tabanlı bir
	// yaklaşık değer hesaplıyor (hata dönmüyor). Windows'ta hata dönerse zaten
	// aşağıdaki err==nil kontrolü metriği atlar, davranış hâlâ güvenli.
	if loadStat, err := load.Avg(); err == nil {
		metrics = append(metrics, metricPayload{MetricName: "system_cpu_load_all_avg1", Value: loadStat.Load1, Unit: ""})
	}

	// system.cpu.num
	if cpuCount, err := cpu.Counts(true); err == nil {
		metrics = append(metrics, metricPayload{MetricName: "system_cpu_num", Value: float64(cpuCount), Unit: ""})
	} else {
		metrics = append(metrics, metricPayload{MetricName: "system_cpu_num", Value: float64(runtime.NumCPU()), Unit: ""})
	}

	// proc.num (parametresiz -- toplam çalışan process sayısı, belirli bir isme göre
	// filtrelenen proc_num_<isim> tarzı dinamik item'lardan FARKLI, ayrı bir metrik).
	if pids, err := process.Pids(); err == nil {
		metrics = append(metrics, metricPayload{MetricName: "proc_num", Value: float64(len(pids)), Unit: ""})
	}

	// kernel.maxproc -- Linux'a özel (/proc/sys/kernel/pid_max), diğer OS'lerde
	// gopsutil'in kapsamadığı bir sysctl değeri, doğrudan dosyadan okunuyor.
	if runtime.GOOS == "linux" {
		if data, err := os.ReadFile("/proc/sys/kernel/pid_max"); err == nil {
			if val, err := strconv.ParseFloat(strings.TrimSpace(string(data)), 64); err == nil {
				metrics = append(metrics, metricPayload{MetricName: "kernel_maxproc", Value: val, Unit: ""})
			}
		}
	}

	// EKSİKLİK DÜZELTMESİ: agent'la (SNMP'siz) izlenen bir cihazda ağ trafiği
	// GÖRÜNMEZDI -- net.if.in[,bytes]/net.if.out[,bytes] karşılığı hiç yoktu.
	// SNMP tarafındaki computeInterfaceRate ile aynı yaklaşım: ham sayaçlar
	// (net_in_bytes/net_out_bytes) HER ZAMAN gönderilir, hız (bps) sadece bir
	// önceki örnekle karşılaştırma mümkünse (computeCounterRate) eklenir.
	now := time.Now()
	if nics, err := psnet.IOCounters(true); err == nil {
		for _, nic := range nics {
			metrics = append(metrics, metricPayload{MetricName: "net_in_bytes", Value: float64(nic.BytesRecv), Unit: "B", Interface: nic.Name})
			metrics = append(metrics, metricPayload{MetricName: "net_out_bytes", Value: float64(nic.BytesSent), Unit: "B", Interface: nic.Name})
			if rate, ok := computeCounterRate("net_in:"+nic.Name, nic.BytesRecv, now); ok {
				metrics = append(metrics, metricPayload{MetricName: "net_in_bps", Value: rate, Unit: "Bps", Interface: nic.Name})
			}
			if rate, ok := computeCounterRate("net_out:"+nic.Name, nic.BytesSent, now); ok {
				metrics = append(metrics, metricPayload{MetricName: "net_out_bps", Value: rate, Unit: "Bps", Interface: nic.Name})
			}
		}
	} else {
		logf("[Collector] ağ arayüzü I/O sayaçları alınamadı: %v", err)
	}

	// EKSİKLİK DÜZELTMESİ: vfs.dev.read/write[,rate] karşılığı hiç yoktu --
	// disk_used_percent SADECE doluluk yüzdesini gösteriyor, bir diskin YAVAŞ
	// olduğunu (yüksek I/O gecikmesi/yoğunluğu) hiçbir şekilde yakalamıyordu.
	// Ham kümülatif sayaçlar (ReadBytes/WriteBytes) burada YAYINLANMIYOR --
	// network'ün aksine, disk I/O'da endüstri standardı (Zabbix/Prometheus
	// node_exporter) ham sayaçları değil doğrudan hızı/IOPS'u izlemektir, bu
	// yüzden bilinçli olarak sadece rate metrikleri var (asimetri kasıtlı).
	if diskIO, err := disk.IOCounters(); err == nil {
		for name, io := range diskIO {
			if rate, ok := computeCounterRate("disk_read_bytes:"+name, io.ReadBytes, now); ok {
				metrics = append(metrics, metricPayload{MetricName: "disk_read_bps", Value: rate, Unit: "Bps", Interface: name})
			}
			if rate, ok := computeCounterRate("disk_write_bytes:"+name, io.WriteBytes, now); ok {
				metrics = append(metrics, metricPayload{MetricName: "disk_write_bps", Value: rate, Unit: "Bps", Interface: name})
			}
			if rate, ok := computeCounterRate("disk_read_count:"+name, io.ReadCount, now); ok {
				metrics = append(metrics, metricPayload{MetricName: "disk_read_iops", Value: rate, Unit: "iops", Interface: name})
			}
			if rate, ok := computeCounterRate("disk_write_count:"+name, io.WriteCount, now); ok {
				metrics = append(metrics, metricPayload{MetricName: "disk_write_iops", Value: rate, Unit: "iops", Interface: name})
			}
		}
	} else {
		logf("[Collector] disk I/O sayaçları alınamadı: %v", err)
	}

	return metrics
}
