package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
)

type releaseInfo struct {
	Version        string `json:"version"`
	Sha256Checksum string `json:"sha256_checksum"`
}

// currentPlatform, GOOS/GOARCH'a göre sunucunun anladığı platform ismini üretir
// (örn. "linux_amd64", "windows_amd64").
func currentPlatform() string {
	return fmt.Sprintf("%s_%s", runtime.GOOS, runtime.GOARCH)
}

// checkForUpdate, sunucudaki en güncel sürümü sorar; kendi sürümünden farklıysa
// yeni binary'i indirip checksum'ını doğrular, geçerliyse kendi yerine koyar ve
// süreci yeniden başlatır (basit bir "indirilen dosyayla mevcut binary'i değiştir" akışı).
func checkForUpdate(cfg *Config) {
	platform := currentPlatform()
	resp, err := httpClient.Get(fmt.Sprintf("%s/api/v1/agent/latest-release?platform=%s", cfg.ServerURL, platform))
	if err != nil {
		logf("[SelfUpdate] Sürüm kontrolü başarısız: %v", err)
		return
	}
	defer resp.Body.Close()

	var release releaseInfo
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		logf("[SelfUpdate] Sürüm yanıtı çözümlenemedi: %v", err)
		return
	}
	if release.Version == "" || release.Version == agentVersion {
		return // güncel, yapılacak bir şey yok
	}

	logf("[SelfUpdate] Yeni sürüm bulundu: %s (mevcut: %s), indiriliyor...", release.Version, agentVersion)

	downloadURL := fmt.Sprintf("%s/api/v1/agent/download/%s/%s", cfg.ServerURL, platform, release.Version)
	downloadResp, err := httpClient.Get(downloadURL)
	if err != nil {
		logf("[SelfUpdate] İndirme başarısız: %v", err)
		return
	}
	defer downloadResp.Body.Close()

	newBinary, err := io.ReadAll(downloadResp.Body)
	if err != nil {
		logf("[SelfUpdate] İndirilen veri okunamadı: %v", err)
		return
	}

	// Checksum doğrulaması — indirilen binary'nin bozulmadığından/değiştirilmediğinden emin ol.
	sum := sha256.Sum256(newBinary)
	if hex.EncodeToString(sum[:]) != release.Sha256Checksum {
		logf("[SelfUpdate] Checksum uyuşmazlığı — güncelleme GÜVENLİK NEDENİYLE iptal edildi")
		return
	}

	execPath, err := os.Executable()
	if err != nil {
		logf("[SelfUpdate] Kendi yolum bulunamadı: %v", err)
		return
	}

	tempPath := execPath + ".new"
	if err := os.WriteFile(tempPath, newBinary, 0755); err != nil {
		logf("[SelfUpdate] Yeni binary yazılamadı: %v", err)
		return
	}

	// GERCEK PLATFORM FARKI: Windows'ta CALISAN bir .exe dosyasi isletim sistemi
	// tarafindan KILITLENIR -- uzerine dogrudan yazmak/rename etmek genelde
	// basarisiz olur ("cannot access the file because it is being used by
	// another process"). Linux'ta calisan bir dosyayi silmek/degistirmek serbesttir
	// (inode tabanli, process eski veriye referans tutmaya devam eder), bu yuzden
	// eski kod SADECE Linux'ta calisiyordu, Windows'ta sessizce basarisiz olurdu.
	// Cozum HER IKI platformda da guvenli: once CALISAN exe'yi KENARA TASI (rename
	// ile isim degistirmek, Windows'ta bile MUMKUNDUR -- process'in data stream'ine
	// olan referansi bozmaz), sonra yeni binary'i BOSALAN eski isme tasi.
	oldPath := execPath + ".old"
	os.Remove(oldPath) // onceki bir guncellemeden kalan .old varsa temizle, hata olursa umursama
	if err := os.Rename(execPath, oldPath); err != nil {
		// GERÇEK HATA (canlı Windows testinde yakalandı): Windows'ta ÇALIŞAN bir
		// servis .exe'si kendi kendini rename EDEMEZ ("Access is denied") --
		// eski varsayım ("rename Windows'ta bile mümkündür") YANLIŞTI. Bu durumda
		// (SADECE Windows'ta anlamlı) bağımsız bir PowerShell "updater" script'i
		// başlatılır -- bu script process TAMAMEN kapandıktan SONRA (artık dosya
		// kilitli değilken) dosyaları değiştirip servisi yeniden başlatır.
		if runtime.GOOS == "windows" {
			if handoffErr := performWindowsSelfUpdateHandoff(execPath, tempPath); handoffErr != nil {
				logf("[SelfUpdate] Windows güncelleme yardımcısı başlatılamadı: %v", handoffErr)
				os.Remove(tempPath)
				return
			}
			logf("[SelfUpdate] Güncelleme indirildi (%s -> %s), servis Recovery mekanizması yeniden başlatacak...", agentVersion, release.Version)
			// GERÇEK HATA (canlı testte bulundu -- zombi process birikimi, 2 farklı
			// deneme başarısız oldu): önce stopService() ile SCM'e "planlı durdurma"
			// bildirmeyi denedik -- BU DA yanlış çıktı, çünkü PLANLI durdurma SCM'in
			// Recovery (Kurtarma) aksiyonlarını TETİKLEMEZ (recovery SADECE
			// "beklenmedik" çökmede devreye girer) -- servis kalıcı olarak
			// "Stopped" kalıyordu. Doğru Windows deseni: os.Exit(0) ile SESSİZCE
			// (SCM'e HİÇBİR planlı durdurma bildirmeden) çık -- service_windows.go'da
			// tanımlı Recovery aksiyonları bunu "beklenmedik çökme" sayıp YENİ
			// (artık güncellenmiş) binary'yi OTOMATİK servis olarak başlatır.
			os.Exit(0)
			return
		}
		logf("[SelfUpdate] Çalışan binary kenara taşınamadı: %v", err)
		os.Remove(tempPath)
		return
	}
	if err := os.Rename(tempPath, execPath); err != nil {
		logf("[SelfUpdate] Yeni binary yerine konulamadı, eski sürüme geri dönülüyor: %v", err)
		os.Rename(oldPath, execPath) // geri al -- eski, calisan binary'i restore et
		return
	}

	logf("[SelfUpdate] Güncelleme başarılı (%s -> %s), yeniden başlatılıyor...", agentVersion, release.Version)
	// GERÇEK HATA (canlı testte bulundu -- zombi process birikiminin ASIL kaynağı
	// buydu): Windows'ta cmd.Start() ile YENİ bir process başlatmak, bu process'i
	// SCM'İN (Service Control Manager) GÖZETİMİ DIŞINDA bırakıyordu -- isRunningAsService()
	// kontrolü FALSE dönüyordu (process SCM tarafından başlatılmadığı için), bu
	// yeni process bir "orphan" (servis DEĞİL, sıradan bir konsol process'i) olarak
	// kalıyordu, SCM ise eski process'in kapanmasını "servis durdu" sayıp servisi
	// "Stopped" işaretliyordu -- process ÇALIŞIYOR ama SCM'İN GÖRDÜĞÜ değil.
	// Windows'ta DOĞRU yol: YENİ process HİÇ başlatma, sadece os.Exit(0) ile çık --
	// service_windows.go'daki Recovery aksiyonları SCM'e YENİ (artık güncellenmiş)
	// binary'yi SERVİS OLARAK doğru şekilde yeniden başlatma görevini bırakır.
	// Linux'ta (systemd Recovery kavramı farklı/opsiyonel) eski davranış korunuyor.
	if runtime.GOOS == "windows" {
		os.Exit(0)
		return
	}
	cmd := exec.Command(execPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err == nil {
		os.Exit(0)
	}
}
