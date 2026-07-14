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
	// Yeni binary'i başlatıp mevcut process'ten çık (systemd/servis yöneticisi varsa
	// zaten yeniden başlatır; burada basit bir exec ile devam ediyoruz).
	cmd := exec.Command(execPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err == nil {
		os.Exit(0)
	}
}
