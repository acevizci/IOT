//go:build !windows

package main

import "fmt"

// Windows dışındaki platformlarda native servis entegrasyonu yok -- Linux zaten
// systemd gibi kendi init sistemini kullanır. Bu komutlar sessizce yanlış bir şeye
// kalkışmak yerine açıkça "desteklenmiyor" der.
func isRunningAsService() (bool, error) { return false, nil }

func runAsService() {} // asla çağrılmaz -- isRunningAsService her zaman false döner

func installService() error {
	return fmt.Errorf("servis kurulumu sadece Windows'ta desteklenir -- Linux'ta systemd kullan")
}

func uninstallService() error {
	return fmt.Errorf("servis kaldırma sadece Windows'ta desteklenir")
}

func startService() error {
	return fmt.Errorf("servis başlatma sadece Windows'ta desteklenir")
}

func stopService() error {
	return fmt.Errorf("servis durdurma sadece Windows'ta desteklenir")
}
