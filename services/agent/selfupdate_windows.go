//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// FAZ J ADIM 8 SIRASINDA BULUNAN GERÇEK HATA (canlı testte yakalandı): Windows'ta
// ÇALIŞAN bir servis .exe'si kendi kendini rename EDEMEZ ("Access is denied") --
// selfupdate.go'daki eski yorum ("rename Windows'ta bile mümkündür") YANLIŞ bir
// varsayımdı, hiç gerçek bir Windows servisinde TEST EDİLMEMİŞTİ. Gerçek, kanıtlanmış
// çözüm: ana process'in DIŞINDA, BAĞIMSIZ bir PowerShell "updater" script'i --
// bu script ana process'in (agent) TAMAMEN kapanmasını bekler (o zaman dosya artık
// kilitli değildir), SONRA dosyaları değiştirir ve servisi yeniden başlatır.
func performWindowsSelfUpdateHandoff(execPath, tempPath string) error {
	scriptPath := execPath + ".update.ps1"
	script := fmt.Sprintf(`
param()
$ErrorActionPreference = "SilentlyContinue"
Wait-Process -Id %d -Timeout 30
Start-Sleep -Seconds 2
Remove-Item "%s.old" -Force
Rename-Item "%s" "%s.old" -Force
Rename-Item "%s" "%s" -Force
Start-Service -Name "%s"
Remove-Item "%s" -Force
`, os.Getpid(), execPath, execPath, execPath, tempPath, execPath, serviceName, scriptPath)

	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		return fmt.Errorf("updater script yazılamadı: %w", err)
	}

	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath)
	// DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP: bu script, agent process'i
	// SONLANDIKTAN SONRA da çalışmaya devam etmeli -- ana process'in bir alt-süreci
	// (child) olarak KALIRSA, ana process kapanınca Windows bunu da öldürebilir.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200} // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
	if err := cmd.Start(); err != nil {
		os.Remove(scriptPath)
		return fmt.Errorf("updater script başlatılamadı: %w", err)
	}
	return nil
}
