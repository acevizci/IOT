//go:build !windows

package main

// PerfCounterPlugin, Windows dışındaki platformlarda hiç var olmaz -- bu dosya
// sadece derlemenin geçmesi için boş bir yer tutucudur, hiçbir şey kaydetmez.
// Config'te "perfcounter" adıyla bir ayar tanımlansa bile initPlugins() bunu
// "bilinmeyen plugin adı" diye loglayıp atlar, agent çökmez.
