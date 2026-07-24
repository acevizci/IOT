package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

var httpClient = &http.Client{Timeout: 15 * time.Second}

type registerResponse struct {
	DeviceID          string `json:"device_id"`
	PSK               string `json:"psk"`
	RedirectServerURL string `json:"redirect_server_url,omitempty"`
}

// register, agent'ın ilk çalıştırmada sunucuya kendi kendine kaydolmasını sağlar.
// Registration token bir kez kullanılır — başarılı kayıttan sonra config'e yazılan
// PSK ile devam edilir, token bir daha gönderilmez.
// localIPAddress, bu makinenin GERCEK yerel IP'sini bulur -- gercekte hicbir baglanti
// KURMADAN (UDP connectionless), isletim sistemine "8.8.8.8'e gitmek icin hangi yerel
// arayuz/IP kullanilir" diye sorarak (yaygin, guvenilir bir Go idiom'u). Onceden bu
// hic gonderilmiyordu, sunucu da bunu HIC yakalamiyordu -- kayitli cihazlar hep
// '0.0.0.0' IP'siyle goruluyordu.
func localIPAddress() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	localAddr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return ""
	}
	return localAddr.IP.String()
}

func register(cfg *Config) error {
	body, _ := json.Marshal(map[string]string{
		"registration_token": cfg.RegistrationToken,
		"hostname":           cfg.Hostname,
		"ip_address":         localIPAddress(),
	})
	resp, err := httpClient.Post(cfg.ServerURL+"/api/v1/agent/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("kayıt isteği başarısız: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("kayıt reddedildi (%d): %s", resp.StatusCode, string(raw))
	}
	var result registerResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("kayıt yanıtı çözümlenemedi: %w", err)
	}
	cfg.DeviceID = result.DeviceID
	cfg.PSK = result.PSK
	cfg.RegistrationToken = "" // bir daha ihtiyaç yok, dosyada tutmaya gerek yok
	// Monitoring Proxy: yeniden kayıt senaryosunda (PSK kaybı/reinstall) cihaz zaten bir
	// proxy'ye atanmış olabilir -- register yanıtı bunu da taşır, applyRedirect ServerURL'i
	// günceller (aşağıdaki saveConfig zaten bunu da kapsayacak şekilde tek seferde yazar).
	if result.RedirectServerURL != "" {
		applyRedirect(cfg, result.RedirectServerURL)
	}
	return saveConfig(cfg)
}

// sendHeartbeat, hafif bir canlılık sinyali gönderir.
// GERÇEK EKSİKLİK DÜZELTMESİ (alarm sistemi incelemesi): sunucu tarafı
// (alarm-engine) agent'ın kaç saniyede bir heartbeat gönderdiğini HİÇ
// bilmiyordu, "varsayılan 10sn" varsayımıyla sabit bir eşik (90sn) kullanıyordu
// -- HeartbeatSeconds farklı yapılandırılmış (örn. düşük bant genişlikli uzak
// bir site için 60sn) bir agent'ta bu ya yanlışlıkla "erişilemez" alarmı
// üretiyordu ya da gereğinden yavaş tespit ediyordu. Artık her heartbeat'te
// kendi aralığını da bildiriyor.
type heartbeatResponse struct {
	RedirectServerURL string `json:"redirect_server_url,omitempty"`
}

// Monitoring Proxy: API SÖZLEŞME DEĞİŞİKLİĞİ -- yanıt önceden 204 No Content'ti
// (gövdesiz), artık redirect_server_url taşımak için 200 + JSON gövdeye geçildi
// (bkz. core-service /api/v1/agent/heartbeat). Heartbeat, agent'ın sunucuya EN SIK
// değdiği çağrı olduğu için proxy ataması değişikliklerinin en hızlı yakalandığı yer
// burası -- ayrıca art arda başarısızlık sayacı (bkz. redirect.go güvenlik ağı) da
// burada besleniyor.
func sendHeartbeat(cfg *Config) error {
	body, _ := json.Marshal(map[string]interface{}{
		"device_id":         cfg.DeviceID,
		"psk":               cfg.PSK,
		"heartbeat_seconds": cfg.HeartbeatSeconds,
	})
	resp, err := httpClient.Post(cfg.ServerURL+"/api/v1/agent/heartbeat", "application/json", bytes.NewReader(body))
	if err != nil {
		recordHeartbeatFailure(cfg)
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		recordHeartbeatFailure(cfg)
		return fmt.Errorf("heartbeat reddedildi (%d): %s", resp.StatusCode, string(raw))
	}
	var result heartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		recordHeartbeatFailure(cfg)
		return fmt.Errorf("heartbeat yanıtı çözümlenemedi: %w", err)
	}
	recordHeartbeatSuccess(cfg)
	if result.RedirectServerURL != "" {
		applyRedirect(cfg, result.RedirectServerURL)
	}
	return nil
}

// FAZ J Adım 7a: Interface (SNMP'ye özel, tek sabit alan) yanına, genel amaçlı
// Tags eklendi -- Hyper-V (ve gelecekteki diğer çoklu-instance kaynaklar) için.
// Tek bir metrik olayı ikisini BİRDEN taşımaz (SNMP interface'leri Interface,
// Hyper-V VM'leri Tags["instance_label"] kullanacak).
type metricPayload struct {
	MetricName string            `json:"metric_name"`
	Value      float64           `json:"value"`
	Unit       string            `json:"unit,omitempty"`
	Interface  string            `json:"interface,omitempty"`
	Tags       map[string]string `json:"tags,omitempty"`
	// Monitoring Proxy düzeltmesi: orijinal TOPLAMA zamanı -- sunucu (ya da araya giren
	// proxy) bu metriği dakikalarca/saatlerce sonra alsa bile (bağlantı kesintisi +
	// yerel kuyruk/buffer), veri doğru zamana yazılsın diye. main.go'da her batch için
	// TEK bir zaman damgası atanır (aynı döngü turunda toplanan metrikler arası birkaç
	// yüz ms fark önemsiz -- asıl kritik olan, SAATLERCE gecikmiş bir batch'in "şimdi"
	// olmuş gibi damgalanmaması).
	Timestamp string `json:"timestamp,omitempty"`
}

// sendMetrics, tam metrik setini gzip ile sıkıştırıp gönderir.
func sendMetrics(cfg *Config, metrics []metricPayload, agentVersion string) error {
	payload := map[string]interface{}{
		"device_id":     cfg.DeviceID,
		"psk":           cfg.PSK,
		"agent_version": agentVersion,
		"metrics":       metrics,
	}
	rawBody, _ := json.Marshal(payload)

	// Content-Type application/octet-stream ile gönderiliyor — application/json olsaydı
	// Gateway'in body parser'ı gzip'li ham byte'ları JSON olarak parse etmeye çalışıp
	// bozuyordu (FST_ERR_CTP_INVALID_CONTENT_LENGTH hatasının kök nedeni buydu).
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	if _, err := gz.Write(rawBody); err != nil {
		return fmt.Errorf("gzip sıkıştırma hatası: %w", err)
	}
	gz.Close()

	req, err := http.NewRequest("POST", cfg.ServerURL+"/api/v1/agent/metrics", &compressed)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "gzip")

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("metrik gönderimi reddedildi (%d): %s", resp.StatusCode, string(raw))
	}
	return nil
}
