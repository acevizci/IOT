package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Server, agent-facing HTTP handler'ların ortak bağımlılıklarını taşır.
type Server struct {
	cfg          *Config
	pool         *pgxpool.Pool
	state        proxyState
	settings     *Settings
	genericProxy *httputil.ReverseProxy

	// GERÇEK EKSİKLİK (kullanıcıyla konuşulup canlı testte bulundu): core'un
	// /api/v1/proxy/heartbeat'i last_successful_sync_at bekliyordu ama proxy bunu
	// HİÇBİR ZAMAN göndermiyordu -- flush'lar başarılı olsa bile Dashboard'da bu
	// alan sonsuza dek NULL kalıyordu. corequeue.go her başarılı flush'ta bunu
	// günceller, selfheartbeat.go bir sonraki heartbeat'te core'a raporlar.
	lastSyncMu           sync.Mutex
	lastSuccessfulSyncAt time.Time
}

func (s *Server) markSyncSuccessful() {
	s.lastSyncMu.Lock()
	s.lastSuccessfulSyncAt = time.Now().UTC()
	s.lastSyncMu.Unlock()
}

func (s *Server) lastSyncAt() (time.Time, bool) {
	s.lastSyncMu.Lock()
	defer s.lastSyncMu.Unlock()
	return s.lastSuccessfulSyncAt, !s.lastSuccessfulSyncAt.IsZero()
}

// genericAgentProxy -- agent'ın register/heartbeat/items/metrics DIŞINDA çağırdığı
// (ör. /api/v1/agent/latest-release, /api/v1/agent/download/*, /api/v1/agent/plugin-config)
// diğer tüm uçlar için şeffaf bir ters proxy. GERÇEK HATA (canlı testte bulundu):
// agent'ın ServerURL'i proxy'yi gösterdiğinde, agent'ın çağırdığı HER endpoint proxy'den
// geçer -- sadece 4 "özel" endpoint'i (register/heartbeat/items/metrics) ele almak
// yeterli DEĞİL, self-update kontrolü ve plugin-config senkronizasyonu da 404 alıyordu.
// Bu genel ters proxy, bugün bilinen VE gelecekte eklenecek herhangi bir agent
// endpoint'ini otomatik kapsar -- core'un yanıt sözleşmesi hiç değişmeden.
func newGenericAgentProxy(coreURL string) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(coreURL)
	if err != nil {
		return nil, err
	}
	return httputil.NewSingleHostReverseProxy(target), nil
}

// forwardToCore, agent'tan gelen HAM gövdeyi olduğu gibi core'a iletir -- yanıtı da
// (redirect_server_url dahil) HİÇ dönüştürmeden agent'a geri yansıtmak için ham byte
// olarak döner. Bu sayede core'un yanıt sözleşmesi değiştiğinde proxy'nin GÜNCELLENMESİ
// gerekmez -- şeffaf bir ara katman.
func forwardToCore(coreURL, path string, body []byte) (statusCode int, respBody []byte, err error) {
	resp, err := httpClient.Post(coreURL+path, "application/json", bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return 0, nil, readErr
	}
	return resp.StatusCode, raw, nil
}

func writeJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	raw, _ := json.Marshal(map[string]string{"error": message})
	writeJSON(w, status, raw)
}

// handleRegister -- yeni cihaz kaydı proxy'nin yerel önbelleğinden ASLA sunulamaz
// (proxy_id/psk'yi ancak core üretebilir) -- her zaman core'a iletilir, core
// ulaşılamazsa agent bir sonraki denemede tekrar dener (agent zaten registerWithRetry
// ile bunu yapıyor).
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "İstek gövdesi okunamadı")
		return
	}
	status, respBody, err := forwardToCore(s.cfg.CoreURL, "/api/v1/agent/register", body)
	if err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "Merkeze ulaşılamıyor, kayıt şu an tamamlanamıyor")
		return
	}
	if status == http.StatusCreated {
		var parsed struct {
			DeviceID string `json:"device_id"`
			Psk      string `json:"psk"`
		}
		if json.Unmarshal(respBody, &parsed) == nil && parsed.DeviceID != "" {
			s.cacheDevice(parsed.DeviceID, parsed.Psk, "")
		}
	}
	writeJSON(w, status, respBody)
}

// handleHeartbeat -- BAŞARILI bir core iletiminde cihazı yerel önbelleğe alır (bir
// sonraki metrics/items çağrısında ve merkez ulaşılamazken heartbeat fallback'inde
// kullanılmak üzere). Core ulaşılamazsa: cihaz DAHA ÖNCE bu proxy üzerinden görüldüyse
// (yerel önbellekte PSK eşleşiyorsa) "fail open" -- 200 + redirect yok, agent olduğu
// yerde/proxy'de kalmaya devam eder, veri akışı kesilmez. Hiç görülmemiş bir cihaz için
// vouch edilemez (503).
func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "İstek gövdesi okunamadı")
		return
	}
	var req struct {
		DeviceID string `json:"device_id"`
		Psk      string `json:"psk"`
	}
	_ = json.Unmarshal(body, &req)

	status, respBody, err := forwardToCore(s.cfg.CoreURL, "/api/v1/agent/heartbeat", body)
	if err != nil {
		if req.DeviceID != "" && s.deviceCacheMatches(req.DeviceID, req.Psk) {
			s.touchDeviceCache(req.DeviceID)
			logf("[Heartbeat] Merkeze ulaşılamadı, önbellekten fail-open: device=%s", req.DeviceID)
			writeJSON(w, http.StatusOK, []byte(`{"redirect_server_url":null}`))
			return
		}
		writeJSONError(w, http.StatusServiceUnavailable, "Merkeze ulaşılamıyor ve cihaz yerel önbellekte yok")
		return
	}
	if status == http.StatusOK && req.DeviceID != "" {
		s.cacheDevice(req.DeviceID, req.Psk, "")
	}
	writeJSON(w, status, respBody)
}

// handleItems -- BAŞARILI bir core iletiminde item listesi yerelde ÖNBELLEKLENİR;
// core ulaşılamazsa (ve cihaz yerel önbellekte biliniyorsa) bu önbellekten sunulur --
// agent'ın RefreshActiveChecks döngüsü merkez kesintisinde boş dönmesin diye.
func (s *Server) handleItems(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "İstek gövdesi okunamadı")
		return
	}
	var req struct {
		DeviceID string `json:"device_id"`
		Psk      string `json:"psk"`
	}
	_ = json.Unmarshal(body, &req)

	status, respBody, err := forwardToCore(s.cfg.CoreURL, "/api/v1/agent/items", body)
	if err != nil {
		if req.DeviceID != "" && s.deviceCacheMatches(req.DeviceID, req.Psk) {
			if cached, ok := s.cachedItems(req.DeviceID); ok {
				logf("[Items] Merkeze ulaşılamadı, önbellekten sunuluyor: device=%s", req.DeviceID)
				writeJSON(w, http.StatusOK, []byte(`{"items":`+cached+`,"redirect_server_url":null}`))
				return
			}
		}
		writeJSONError(w, http.StatusServiceUnavailable, "Merkeze ulaşılamıyor ve önbellekte item listesi yok")
		return
	}
	if status == http.StatusOK && req.DeviceID != "" {
		var parsed struct {
			Items json.RawMessage `json:"items"`
		}
		if json.Unmarshal(respBody, &parsed) == nil && parsed.Items != nil {
			s.cacheItems(req.DeviceID, string(parsed.Items))
		}
	}
	writeJSON(w, status, respBody)
}

// handleMetrics -- kullanıcıyla konuşulup kararlaştırılan tasarımın KALBİ: metrikler
// ASLA senkron olarak core'a iletilmez, doğrudan yerel Postgres kuyruğuna yazılır ve
// agent'a ANINDA 204 dönülür. Ayrı bir arka plan döngüsü (bkz. corequeue.go) bu
// kuyruğu periyodik olarak core'a batch halinde boşaltır -- ORİJİNAL toplama zaman
// damgasıyla (agent şimdi bunu gönderiyor, yoksa proxy'nin "şimdi"si fallback).
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceID     string `json:"device_id"`
		Psk          string `json:"psk"`
		AgentVersion string `json:"agent_version"`
		Metrics      []struct {
			MetricName string            `json:"metric_name"`
			Value      float64           `json:"value"`
			Unit       string            `json:"unit,omitempty"`
			Interface  string            `json:"interface,omitempty"`
			Tags       map[string]string `json:"tags,omitempty"`
			Timestamp  string            `json:"timestamp,omitempty"`
		} `json:"metrics"`
	}
	// GERÇEK HATA (canlı agent binary'siyle testte bulundu): agent, metrikleri HER ZAMAN
	// gzip'leyip Content-Type: application/octet-stream + Content-Encoding: gzip ile
	// gönderir (bkz. services/agent/client.go sendMetrics -- core-service'in Gateway'in
	// body parser'ını atlamak için kullandığı AYNI desen). Bunu çözmeden doğrudan JSON
	// decode denemek her zaman "İstek gövdesi çözümlenemedi" ile patlıyordu.
	var bodyReader io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "gzip gövdesi açılamadı")
			return
		}
		defer gz.Close()
		bodyReader = gz
	}
	if err := json.NewDecoder(bodyReader).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "İstek gövdesi çözümlenemedi")
		return
	}
	if req.DeviceID == "" || !s.deviceCacheMatches(req.DeviceID, req.Psk) {
		// Cihaz bu proxy üzerinden HENÜZ hiç register/heartbeat olmadıysa önbellekte
		// yok demektir -- agent'ın heartbeat döngüsü (varsayılan 10sn, metrics'ten
		// -60sn- daha sık) bunu kısa sürede dolduracaktır, agent otomatik tekrar dener.
		writeJSONError(w, http.StatusUnauthorized, "Cihaz yerel önbellekte tanınmıyor (önce heartbeat/register gerekli)")
		return
	}
	s.touchDeviceCache(req.DeviceID)

	now := time.Now().UTC()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	batch := &pgx.Batch{}
	for _, m := range req.Metrics {
		ts := now
		if m.Timestamp != "" {
			if parsed, err := time.Parse(time.RFC3339, m.Timestamp); err == nil {
				ts = parsed
			}
		}
		tagsJSON := "null"
		if m.Tags != nil {
			if raw, err := json.Marshal(m.Tags); err == nil {
				tagsJSON = string(raw)
			}
		}
		batch.Queue(
			`INSERT INTO metric_queue (device_id, psk, agent_version, metric_name, value, unit, interface, tags_json, metric_timestamp)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			req.DeviceID, req.Psk, req.AgentVersion, m.MetricName, m.Value, m.Unit, m.Interface, tagsJSON, ts,
		)
	}
	if batch.Len() > 0 {
		br := s.pool.SendBatch(ctx, batch)
		if err := br.Close(); err != nil {
			logf("[Metrics] Kuyruğa yazma hatası: %v", err)
			writeJSONError(w, http.StatusInternalServerError, "Metrikler kuyruğa yazılamadı")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, []byte(`{"status":"ok"}`))
}

func (s *Server) cacheDevice(deviceID, psk, agentVersion string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := s.pool.Exec(ctx,
		`INSERT INTO device_cache (device_id, psk, agent_version, last_seen_at) VALUES ($1, $2, $3, now())
		 ON CONFLICT (device_id) DO UPDATE SET psk = $2, agent_version = COALESCE(NULLIF($3, ''), device_cache.agent_version), last_seen_at = now()`,
		deviceID, psk, agentVersion,
	)
	if err != nil {
		logf("[Cache] Cihaz önbelleğe yazılamadı: %v", err)
	}
}

func (s *Server) touchDeviceCache(deviceID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = s.pool.Exec(ctx, `UPDATE device_cache SET last_seen_at = now() WHERE device_id = $1`, deviceID)
}

func (s *Server) deviceCacheMatches(deviceID, psk string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var stored string
	err := s.pool.QueryRow(ctx, `SELECT psk FROM device_cache WHERE device_id = $1`, deviceID).Scan(&stored)
	if err != nil {
		return false
	}
	return stored == psk
}

func (s *Server) cacheItems(deviceID, itemsJSON string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := s.pool.Exec(ctx,
		`INSERT INTO item_cache (device_id, items_json, updated_at) VALUES ($1, $2, now())
		 ON CONFLICT (device_id) DO UPDATE SET items_json = $2, updated_at = now()`,
		deviceID, itemsJSON,
	)
	if err != nil {
		logf("[Cache] Item listesi önbelleğe yazılamadı: %v", err)
	}
}

func (s *Server) cachedItems(deviceID string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var itemsJSON string
	err := s.pool.QueryRow(ctx, `SELECT items_json FROM item_cache WHERE device_id = $1`, deviceID).Scan(&itemsJSON)
	if err != nil {
		return "", false
	}
	return itemsJSON, true
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent/register", s.handleRegister)
	mux.HandleFunc("/api/v1/agent/heartbeat", s.handleHeartbeat)
	mux.HandleFunc("/api/v1/agent/items", s.handleItems)
	mux.HandleFunc("/api/v1/agent/metrics", s.handleMetrics)
	mux.HandleFunc("/health", s.handleHealth)

	// Yukarıdaki 4 özel-durumlu endpoint DIŞINDA kalan her /api/v1/agent/* isteği
	// (latest-release, download, plugin-config, ileride eklenecek herhangi biri) için
	// şeffaf ters proxy -- ServeMux'ta daha SPESİFİK (tam eşleşen) pattern'ler her zaman
	// bu önekten önce gelir, bu yüzden çakışma olmaz.
	if s.genericProxy != nil {
		mux.Handle("/api/v1/agent/", s.genericProxy)
	}
	return mux
}
