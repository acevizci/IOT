//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "IoTObservabilityAgent"
const serviceDisplayName = "IoT Observability Agent"

func isRunningAsService() (bool, error) {
	return svc.IsWindowsService()
}

// agentServiceHandler, Windows SCM (Service Control Manager) ile agent'in ana
// döngüsü arasındaki köprüdür. Execute() metodu SCM tarafından çağrılır.
type agentServiceHandler struct{}

func (h *agentServiceHandler) Execute(args []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	stopCh := make(chan struct{})
	status <- svc.Status{State: svc.StartPending}

	go runAgentLoop(stopCh)

	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}

	for {
		req := <-requests
		switch req.Cmd {
		case svc.Interrogate:
			status <- req.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			close(stopCh)
			// runAgentLoop'un kendi ticker/goroutine'lerinin temiz kapanması için
			// kısa bir süre tanıyoruz -- agent'ta context iptali her yerde
			// dallanmadığı için tam graceful shutdown yerine pragmatik bir bekleme.
			time.Sleep(500 * time.Millisecond)
			status <- svc.Status{State: svc.Stopped}
			return false, 0
		}
	}
}

func runAsService() {
	// GERCEK ONEMLI DETAY: Windows SCM, servisleri VARSAYILAN olarak
	// C:\Windows\System32 çalışma dizininde başlatır -- agent_config.json'u
	// (relatif path ile aranıyor) bu yüzden HİÇ BULAMAZDI. Exe'nin kendi
	// dizinine geçiyoruz ki config/kuyruk dosyaları doğru yerde aransın.
	if exePath, err := os.Executable(); err == nil {
		os.Chdir(filepath.Dir(exePath))
	}

	if err := svc.Run(serviceName, &agentServiceHandler{}); err != nil {
		fmt.Printf("[Agent] Servis çalıştırılamadı: %v\n", err)
		os.Exit(1)
	}
}

func installService() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("çalıştırılabilir dosya yolu alınamadı: %w", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("Service Control Manager'a bağlanılamadı (bu komutu Yönetici olarak çalıştırdığından emin ol): %w", err)
	}
	defer m.Disconnect()

	existing, err := m.OpenService(serviceName)
	if err == nil {
		existing.Close()
		return fmt.Errorf("servis zaten kurulu -- önce 'uninstall' ile kaldır")
	}

	s, err := m.CreateService(serviceName, exePath, mgr.Config{
		DisplayName: serviceDisplayName,
		Description: "IoT Datacenter Observability platformu için metrik toplama agent'ı",
		StartType:   mgr.StartAutomatic,
	})
	if err != nil {
		return fmt.Errorf("servis oluşturulamadı: %w", err)
	}
	defer s.Close()

	// GERÇEK HATA (canlı testte bulundu): self-update, KENDİ servisine "Stop"
	// sinyali gönderip TEMİZ şekilde kapansa bile, YENİ (güncellenmiş) binary'yi
	// KİM başlatacak? Windows'ta bir servis process'i KENDİ SERVİSİNİ "Start"
	// EDEMEZ (SCM, henüz "durduruluyor" aşamasındayken çakışan bir "başlat"
	// isteğini reddeder). Denenen alternatif (doğrudan cmd.Start() ile yeni bir
	// process başlatıp kendisi çıkma) DAHA KÖTÜ bir sonuç verdi -- yeni process
	// SCM'İN GÖZETİMİ DIŞINDA (servis olarak DEĞİL, "orphan" bir process olarak)
	// başlıyordu, tam olarak gözlemlenen "zombi process" davranışının nedeniydi.
	// DOĞRU Windows deseni: servisin "Recovery" (Kurtarma) ayarlarını kullanmak --
	// self-update process'i os.Exit(0) ile SESSİZCE (SCM'e "planlı durdurma"
	// bildirmeden) çıkar, SCM bunu "beklenmedik çökme" sayıp burada tanımlı
	// Recovery aksiyonlarına göre YENİ (artık güncellenmiş) binary'yi OTOMATİK
	// olarak SERVİS OLARAK yeniden başlatır.
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, uint32((24 * time.Hour).Seconds())); err != nil {
		// Kritik değil -- kurulum devam edebilir, sadece self-update sonrası
		// otomatik yeniden başlama çalışmayabilir (kullanıcı elle Start-Service
		// yapması gerekebilir). Hata olarak DÖNDÜRMÜYORUZ, sadece bilgi.
		fmt.Printf("[Agent] Uyarı: Recovery ayarları yapılandırılamadı (self-update sonrası otomatik yeniden başlama çalışmayabilir): %v\n", err)
	}

	return nil
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("Service Control Manager'a bağlanılamadı: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("servis bulunamadı (zaten kurulu değil olabilir): %w", err)
	}
	defer s.Close()

	if err := s.Delete(); err != nil {
		return fmt.Errorf("servis silinemedi: %w", err)
	}
	return nil
}

func startService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("Service Control Manager'a bağlanılamadı: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("servis bulunamadı (önce 'install' ile kur): %w", err)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		return fmt.Errorf("servis başlatılamadı: %w", err)
	}
	return nil
}

func stopService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("Service Control Manager'a bağlanılamadı: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("servis bulunamadı: %w", err)
	}
	defer s.Close()

	if _, err := s.Control(svc.Stop); err != nil {
		return fmt.Errorf("durdurma sinyali gönderilemedi: %w", err)
	}
	return nil
}
