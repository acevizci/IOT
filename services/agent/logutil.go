package main

import (
	"io"
	"log"
	"os"
	"path/filepath"
)

// logf, tüm modüllerin ortak kullandığı basit bir log sarmalayıcısı.
func logf(format string, args ...interface{}) {
	log.Printf(format, args...)
}

// EKSİKLİK DÜZELTMESİ: Windows Service olarak çalışırken standart `log` paketinin
// varsayılan çıktısı (os.Stderr) hiçbir konsola bağlı değildir -- SCM altında çalışan
// bir process'in stderr'i hiçbir yere gitmez, dolayısıyla TÜM loglar (self-update,
// hata mesajları, her şey) sessizce kayboluyordu. setupFileLogging(), çalıştırılabilir
// dosyanın YANINA (çalışma dizininden bağımsız -- selfupdate.go'daki os.Executable()
// deseniyle tutarlı) "agent.log" dosyası açar ve log çıktısını hem bu dosyaya hem de
// (varsa) konsola yönlendirir. Basit bir boyut kontrolü ile sınırsız büyümeyi önler.
const maxLogFileBytes = 10 * 1024 * 1024 // 10 MB

func setupFileLogging() {
	exePath, err := os.Executable()
	if err != nil {
		log.Println("[Agent] Log dosyası için exe yolu bulunamadı, sadece konsola/stderr'e yazılacak:", err)
		return
	}
	logPath := filepath.Join(filepath.Dir(exePath), "agent.log")

	// Basit rotasyon: dosya çok büyüdüyse bir öncekini .old'a taşı, yeni dosyaya sıfırdan başla.
	if info, err := os.Stat(logPath); err == nil && info.Size() > maxLogFileBytes {
		oldPath := logPath + ".old"
		os.Remove(oldPath) // önceki .old varsa sessizce üzerine yaz
		os.Rename(logPath, oldPath)
	}

	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Println("[Agent] Log dosyası açılamadı, sadece konsola/stderr'e yazılacak:", err)
		return
	}

	// Hem dosyaya hem de mevcut çıktıya (konsol modunda görünür olsun diye) yaz --
	// servis modunda ikinci hedef zaten hiçbir yere gitmiyor olsa da zararı yok.
	log.SetOutput(io.MultiWriter(file, os.Stderr))
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	log.Printf("[Agent] Log dosyası: %s", logPath)
}
