//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
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
	logPath := execPath + ".update.log"
	// GERÇEK HATA (canlı testte bulundu): önceki script'te "$ErrorActionPreference =
	// SilentlyContinue" TÜM hataları SESSİZCE YUTUYORDU -- script bir yerde takılıp
	// kaldı/başarısız oldu ama HİÇBİR İZ bırakmadı (kendini silmesi gerekirken script
	// dosyası HÂLÂ DİSKTE duruyordu, servis "Stopped" kaldı). Şimdi HER ADIM ayrı
	// try/catch ile bir LOG DOSYASINA yazılıyor -- bir sonraki hata bu şekilde
	// TEŞHİS EDİLEBİLECEK.
	script := fmt.Sprintf(`
$logFile = "%s"
function Log($msg) { Add-Content -Path $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') $msg" }
Log "Handoff script başladı. PID beklenecek: %d"
try {
	Wait-Process -Id %d -Timeout 30 -ErrorAction Stop
	Log "Process %d sonlandı (Wait-Process başarılı)."
} catch {
	Log "Wait-Process hatası (muhtemelen process zaten sonlanmıştı, devam ediliyor): $_"
}
Start-Sleep -Seconds 2
try {
	if (Test-Path "%s.old") { Remove-Item "%s.old" -Force; Log "Eski .old dosyası temizlendi." }
	Rename-Item "%s" "%s.old" -Force -ErrorAction Stop
	Log "Çalışan binary .old olarak taşındı."
	Rename-Item "%s" "%s" -Force -ErrorAction Stop
	Log "Yeni binary yerine kondu."
	Start-Service -Name "%s" -ErrorAction Stop
	Log "Servis başarıyla başlatıldı. Handoff TAMAMLANDI."
} catch {
	Log "HATA: $_"
	Log "Servis mevcut durumu: $((Get-Service -Name '%s' -ErrorAction SilentlyContinue).Status)"
}
Remove-Item "%s" -Force -ErrorAction SilentlyContinue
`, logPath, os.Getpid(), os.Getpid(), os.Getpid(), execPath, execPath, execPath, execPath, tempPath, execPath, serviceName, serviceName, scriptPath)

	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		return fmt.Errorf("updater script yazılamadı: %w", err)
	}

	// GERÇEK HATA (canlı testte bulundu, 3 ardışık denemede de aynı sonuç): Windows
	// Service Control Manager'ın başlattığı çocuk process'ler bir "Job Object"e
	// bağlıdır -- ana process (agent) os.Exit(0) ile kapanınca, Job'daki TÜM
	// process'ler (DETACHED_PROCESS/CREATE_NEW_PROCESS_GROUP flag'leriyle
	// başlatılmış olsa bile) OTOMATİK SONLANDIRILIYOR, script hiç ÇALIŞMADAN
	// ölüyordu (log dosyası hiç oluşmuyordu). Windows Task Scheduler'ın başlattığı
	// process'ler ise TAMAMEN AYRI bir process ağacında (servisin Job'undan
	// bağımsız) çalışır -- bu yüzden schtasks.exe ile GEÇİCİ bir görev oluşturup
	// hemen tetikliyoruz.
	taskName := "IoTAgentSelfUpdateHandoff"
	taskRun := fmt.Sprintf(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%s"`, scriptPath)
	createCmd := exec.Command("schtasks", "/Create", "/TN", taskName, "/TR", taskRun, "/SC", "ONCE", "/ST", "00:00", "/RU", "SYSTEM", "/F")
	if out, err := createCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks görevi oluşturulamadı: %w (çıktı: %s)", err, string(out))
	}
	runCmd := exec.Command("schtasks", "/Run", "/TN", taskName)
	if out, err := runCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks görevi tetiklenemedi: %w (çıktı: %s)", err, string(out))
	}
	return nil
}
