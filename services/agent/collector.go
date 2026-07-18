package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/process"
)

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
				continue
			}
			metrics = append(metrics, metricPayload{
				MetricName: "disk_used_percent", Value: usage.UsedPercent, Unit: "%", Interface: p.Mountpoint,
			})
		}
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

	// system.cpu.load[all,avg1] -- SADECE Linux/macOS'ta anlamlı (Windows'ta load
	// average kavramı yok, gopsutil orada hata döner -- sessizce atlanır, uydurma
	// bir değer verilmez).
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

	return metrics
}
