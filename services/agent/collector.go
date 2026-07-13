package main

import (
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
)

// collectMetrics, MVP kapsamındaki temel OS metriklerini toplar:
// cpu_util, memory_used_percent, disk_used_percent (mount point'e göre), system_uptime.
func collectMetrics() []metricPayload {
	var metrics []metricPayload

	if percentages, err := cpu.Percent(0, false); err == nil && len(percentages) > 0 {
		metrics = append(metrics, metricPayload{MetricName: "cpu_util", Value: percentages[0], Unit: "%"})
	}

	if vmStat, err := mem.VirtualMemory(); err == nil {
		metrics = append(metrics, metricPayload{MetricName: "memory_used_percent", Value: vmStat.UsedPercent, Unit: "%"})
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

	return metrics
}
