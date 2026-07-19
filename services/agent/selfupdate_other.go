//go:build !windows

package main

import "fmt"

// Linux'ta rename tabanlı yaklaşım zaten çalışıyor (bkz. selfupdate.go) -- bu
// fonksiyon Windows-özel yol dışında hiç çağrılmaz, sadece derleme bütünlüğü için var.
func performWindowsSelfUpdateHandoff(execPath, tempPath string) error {
	return fmt.Errorf("performWindowsSelfUpdateHandoff sadece Windows'ta desteklenir")
}
