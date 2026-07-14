#!/usr/bin/env python3
"""
Zabbix YAML export'unu (zbx_export_templates.yaml) bizim platformumuza aktarır.

Kullanım:
    python3 import_zabbix_templates.py <yaml_dosya_yolu> <email> <şifre>

Örnek:
    python3 import_zabbix_templates.py zbx_export_templates.yaml snmp2@test.com guclu-sifre-789

Ne yapar:
  - 44 template'i tarar, her biri için:
    - Template'i oluşturur (isim, tags)
    - Basit (context'siz) makroları oluşturur
    - SNMP_AGENT, SIMPLE (icmp/tcp), HTTP_AGENT, DEPENDENT item'ları oluşturur
    - httptest'leri (Web Scenario) oluşturur
    - Basit tek-fonksiyonlu trigger'ları (last(...)>X gibi) alarm kuralı olarak ekler
  - Desteklenmeyen/karmaşık öğeleri (Agent tipi item, SNMP Trap, Internal, Calculated,
    context'li makro, çok fonksiyonlu trigger, LLD discovery/tablo item) ATLAR ve
    sonunda ayrıntılı bir rapor basar — hiçbir şey sessizce kaybolmaz.

Tekrar çalıştırılabilir (idempotent): Bir template zaten varsa, o template atlanır
(üzerine yazılmaz) — script'i güvenle tekrar çalıştırabilirsin.
"""

import sys
import json
import re
import yaml
import urllib.request
import urllib.error

GATEWAY_URL = "http://localhost:8080"


def api_call(method, path, token=None, body=None):
    url = f"{GATEWAY_URL}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw.decode("utf-8", errors="ignore")}
    except Exception as e:
        return 0, {"error": str(e)}


def login(email, password):
    status, body = api_call("POST", "/api/v1/auth/login", body={"email": email, "password": password})
    if status != 200:
        print(f"HATA: Giriş başarısız ({status}): {body}")
        sys.exit(1)
    return body["token"]


# ============ TRIGGER EXPRESSION PARSER (sadece basit tek-fonksiyonlu ifadeler) ============
# Desteklenen kalıp: fn(/Template/key,...)OP{$MACRO_veya_sayı}
# Örn: last(/Cisco IOS by SNMP/icmpping)=0  ->  desteklenmez (last...=0, eq ama key'siz koşul karmaşık)
#      last(/X/key)>{$MACRO}                ->  desteklenir
#      last(/X/key)>90                      ->  desteklenir
SIMPLE_TRIGGER_RE = re.compile(
    r"^(?:last|min|max|avg)\(/([^/]+)/([^,)]+?)(?:,([^)]*))?\)\s*([<>=])\s*(\{[^}]+\}|[\d.]+)$"
)
WEB_TEST_TIME_RE = re.compile(
    r"^(?:last|min|max|avg)\(/([^/]+)/web\.test\.time\[([^,]+),([^,]+),resp\](?:,([^)]*))?\)\s*([<>=])\s*(\{[^}]+\}|[\d.]+)$"
)

def parse_duration_to_seconds(duration_raw):
    if not duration_raw:
        return 60
    duration_raw = duration_raw.strip()
    m = re.match(r"^(\d+)([smhd]?)$", duration_raw)
    if not m:
        return 60
    value, unit = int(m.group(1)), m.group(2) or "s"
    multiplier = {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
    return value * multiplier

def parse_threshold(threshold_raw):
    if threshold_raw.startswith("{$"):
        return {"threshold_macro_key": threshold_raw, "threshold": 0}
    try:
        return {"threshold": float(threshold_raw)}
    except ValueError:
        return None

def parse_simple_trigger(expression, key_to_metric_name):
    m = SIMPLE_TRIGGER_RE.match(expression.strip())
    if not m:
        return None
    _template_ref, key, duration_raw, op, threshold_raw = m.groups()
    if key.startswith("web.test.time"):
        return None
    metric_name = key_to_metric_name.get(key)
    if not metric_name:
        return None
    threshold_fields = parse_threshold(threshold_raw)
    if threshold_fields is None:
        return None
    condition = {">": "gt", "<": "lt", "=": "eq"}[op]
    rule = {
        "metric_name": metric_name,
        "condition": condition,
        "duration_seconds": parse_duration_to_seconds(duration_raw),
        "severity": "warning",
    }
    rule.update(threshold_fields)
    return rule

def parse_web_test_trigger(expression):
    m = WEB_TEST_TIME_RE.match(expression.strip())
    if not m:
        return None
    _template_ref, scenario_name, step_name, duration_raw, op, threshold_raw = m.groups()
    threshold_fields = parse_threshold(threshold_raw)
    if threshold_fields is None:
        return None
    condition = {">": "gt", "<": "lt", "=": "eq"}[op]
    result = {
        "scenario_name": scenario_name.strip(),
        "step_name": step_name.strip(),
        "condition": condition,
        "duration_seconds": parse_duration_to_seconds(duration_raw),
        "severity": "warning",
    }
    result.update(threshold_fields)
    return result

def web_scenario_metric_name(scenario_name, step_name):
    def clean(s):
        return re.sub(r"\s+", "_", s.strip())
    return f"web_{clean(scenario_name)}_{clean(step_name)}_response_time_ms"
SEVERITY_MAP = {
    "NOT_CLASSIFIED": "info", "INFO": "info", "WARNING": "warning",
    "AVERAGE": "average", "HIGH": "high", "DISASTER": "disaster",
}



# Zabbix'in agent item key'lerini (ZABBIX_PASSIVE/ZABBIX_ACTIVE tipi), bizim Go
# Agent'ımızın GERÇEKTEN ürettiği metrik isimlerine eşler. Sadece agent'ın halihazırda
# topladığı ya da (proc.num gibi) sunucudan dinamik parametreyle besleyebildiği
# key'ler eşlenir — eşlenmeyenler (perf_counter_en, docker.*, pgsql.*, redis.*, wmi.*)
# BİLİNÇLİ olarak atlanıp raporlanır, çünkü agent'ta bunlar için hiç toplama kodu yok.
AGENT_KEY_MAPPING = {
    "system.cpu.util": "cpu_util",
    "vm.memory.size": "memory_used_percent",
    "system.uptime": "system_uptime",
}
# Bu key'ler, agent'ın dinamik "sunucudan gelen process_pattern ile process say" özelliğini kullanır.
AGENT_PROC_NUM_KEY = "proc.num"

# Faz F sonrasi: gercek Zabbix docker.*/pgsql.*/redis.* key'lerini, agent'in native
# plugin'lerinin (Docker/PostgreSQL/Redis) desteklendigi action'larina esler.
# connection_config artik BOS ({}) degil, {"plugin": ..., "action": ...} seklinde
# plugin'e yonlendirme bilgisi tasir. SADECE gercekten desteklenen action'lar eslenir --
# docker.info/data_usage, pgsql.bgwriter/replication.*, redis.config gibi yapisal/JSON
# donen key'ler BILINCLI olarak atlanir (Collect()'in float64 donus tipiyle uyumlu degil).
PLUGIN_KEY_MAPPING = {
    "docker.ping": {"plugin": "docker", "action": "ping"},
    "docker.containers": {"plugin": "docker", "action": "container_count"},  # parametre: running/all
    "docker.images": {"plugin": "docker", "action": "image_count"},
    "pgsql.ping": {"plugin": "postgres", "action": "ping"},
    "pgsql.connections": {"plugin": "postgres", "action": "connections"},
    "pgsql.uptime": {"plugin": "postgres", "action": "uptime"},
    "pgsql.locks": {"plugin": "postgres", "action": "locks"},
    "redis.ping": {"plugin": "redis", "action": "ping"},
    "redis.slowlog.count": {"plugin": "redis", "action": "slowlog_count"},
}

def build_plugin_connection_config(root_key, ikey):
    """PLUGIN_KEY_MAPPING'teki bir key icin connection_config'i olusturur --
    docker.containers[running] gibi parametreli key'lerde parametreyi de ekler."""
    base = dict(PLUGIN_KEY_MAPPING[root_key])
    if root_key == "docker.containers":
        param_match = re.search(r"\[([^,\]]+)\]", ikey or "")
        state = param_match.group(1) if param_match else "running"
        if "{$" not in state:
            base["state"] = state
    return base

def build_windows_connection_config(root_key, ikey):
    """perf_counter_en[...] / wmi.get[...] / wmi.getall icin -- path/sorgu Zabbix
    key'inin parametresinden dogrudan alinir, sabit bir eslesme tablosu degil."""
    param_match = re.search(r"\[(.+)\]$", ikey or "")
    param = param_match.group(1) if param_match else None
    if param:
        param = param.strip('"')  # Zabbix export'u parametreyi tirnak icinde veriyor -- PDH/WMI'ye
                                    # gonderilecek path/sorgu bu tirnaklari ICERMEMELI, aksi halde
                                    # gecersiz bir counter path/WQL olarak reddedilir.
    if param and "{$" in param:
        return None  # makro referansi, cihaza atanmadan cozulemez -- guvenilir degil
    if root_key == "perf_counter_en":
        if not param:
            return None
        return {"plugin": "perfcounter", "path": param}
    if root_key in ("wmi.get", "wmi.getall"):
        if not param:
            return None
        # Zabbix formati: wmi.get[<namespace>,<query>] -- namespace'i atla, query'yi al
        # (yusufpapurcu/wmi varsayilan olarak root\cimv2 kullanir, ayrica belirtmeye
        # gerek yok). WQL'in "AS" alias'i desteklemedigini gercek Windows testinde
        # ogrendik -- bu yuzden query'nin SELECT listesinden GERCEK WMI ozellik adini
        # (field) de ayrica PARSE etmemiz gerekiyor. SADECE TEK BIR kolon SELECT eden
        # sorgular bizim modelimize (tek float64 deger donen Collect()) uyuyor --
        # birden fazla kolon SELECT eden (orn. wmi.getall'in tipik "tum satirlari JSON
        # olarak don" kullanimlari) BILINCLI olarak atlanir, uydurma bir field secilmez.
        comma_idx = param.find(",")
        query_part = (param[comma_idx + 1:].strip() if comma_idx != -1 else param).strip('"').strip("'")
        field_match = re.match(r"(?i)select\s+([a-zA-Z0-9_]+)\s+from\s", query_part)
        if not field_match:
            return None  # birden fazla kolon SELECT ediyor ya da parse edilemedi -- desteklenmiyor
        return {"plugin": "wmi", "query": query_part, "field": field_match.group(1)}
    return None


def main():
    if len(sys.argv) != 4:
        print("Kullanım: python3 import_zabbix_templates.py <yaml_dosya> <email> <şifre>")
        sys.exit(1)

    yaml_path, email, password = sys.argv[1], sys.argv[2], sys.argv[3]

    with open(yaml_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    templates = data["zabbix_export"]["templates"]
    # KRİTİK DÜZELTME: trigger'lar item'ların İÇİNDE değil, zabbix_export'un ÜST
    # seviyesinde, ayrı bir liste olarak duruyor. Önceki kod item.get("triggers", [])
    # ile item içinden okumaya çalışıyordu — bu HER ZAMAN boş liste döndürüyordu,
    # 71 gerçek trigger'ın hiçbiri hiç denenmiyordu bile (rapor "0 kural" gösteriyordu
    # ama gerçek anlamı "hiç bakılmadı"ydı, "hiç trigger yok" değil).
    all_triggers = data["zabbix_export"].get("triggers", [])
    # Her trigger'ın hangi template'e ait olduğunu, expression'ın İÇİNDEKİ
    # /TemplateAdı/ referansından çıkarıp gruplayalım.
    # search (match değil) kullanıyoruz çünkü karmaşık ifadeler ( ile başlayabiliyor
    # (örn. "(last(/X/a)-last(/X/b))>5") — ifadenin herhangi bir yerindeki İLK
    # /TemplateAdı/ referansını buluyoruz, konumdan bağımsız.
    TEMPLATE_REF_RE = re.compile(r"/([^/]+)/")
    triggers_by_template = {}
    for trig in all_triggers:
        expr = trig.get("expression", "")
        m = TEMPLATE_REF_RE.search(expr.strip())
        tmpl_name = m.group(1) if m else None
        if tmpl_name:
            triggers_by_template.setdefault(tmpl_name, []).append(trig)
    print(f"Üst seviyeden okunan toplam trigger: {len(all_triggers)} (template'e göre gruplandı: {len(triggers_by_template)} farklı template)\n")

    token = login(email, password)
    print(f"Giriş başarılı. {len(templates)} template işlenecek.\n")

    report = {
        "created_templates": [], "skipped_templates": [],
        "created_items": 0, "skipped_items": [],
        "created_macros": 0, "skipped_macros": [],
        "created_rules": 0, "skipped_triggers": [],
        "created_scenarios": 0,
    }

    # Zaten var olan template isimlerini çek (idempotency için)
    status, existing = api_call("GET", "/api/v1/alert-templates", token=token)
    existing_map = {t["name"]: t["id"] for t in existing} if status == 200 and existing else {}
    for t in templates:
        tname = t["name"]
        template_already_existed = tname in existing_map
        if template_already_existed:
            print(f"[MEVCUT] '{tname}' zaten var - sadece YENI item'lar (agent-tipi vb.) eklenecek.")
            template_id = existing_map[tname]
            # KRİTİK DÜZELTME: GET /alert-templates/:id'nin HİÇ "items" alanı yok
            # (sadece rules/children döner) -- item'lar AYRI bir endpoint'te
            # (/alert-templates/:id/items). Önceki kod .get("items", []) ile HER ZAMAN
            # boş sete düşüyordu, dedup kontrolü hiç çalışmıyordu -- script her
            # çalıştırmada sessizce yeni duplicate item oluşturuyordu (DB'de gerçek
            # kanıtla doğrulandı: bazı metric_name'ler 5 kez tekrarlanmış).
            _, existing_detail = api_call("GET", f"/api/v1/alert-templates/{template_id}", token=token)
            _, existing_items_list = api_call("GET", f"/api/v1/alert-templates/{template_id}/items", token=token)
            existing_metric_names = {i["metric_name"] for i in (existing_items_list or [])}
            # key_to_metric_name burada da inşa edilmeli — trigger'lar bu haritayı
            # kullanıyor, ama "zaten var" dalında item'lar API'den tekrar OLUŞTURULMUYOR
            # (zaten mevcutlar), sadece agent-tipi YENİ item'lar ekleniyor. Metrik ismi
            # türetimi DETERMİNİSTİK olduğu için (aynı YAML item her zaman aynı
            # metric_name'i üretir), DB'den tekrar okumaya gerek yok -- YAML'daki
            # item'ları tarayıp aynı dönüşümü tekrar uygulamak yeterli ve doğru.
            key_to_metric_name = {}
            for item in t.get("items", []):
                itype = item.get("type", "ZABBIX_PASSIVE")
                ikey = item.get("key")
                iname = item.get("name", ikey or "?")
                if itype in ("SNMP_AGENT", "SIMPLE", "HTTP_AGENT", "DEPENDENT") and ikey:
                    key_to_metric_name[ikey] = re.sub(r"[^a-zA-Z0-9_]", "_", ikey or iname)[:60]
            for item in t.get("items", []):
                itype = item.get("type", "ZABBIX_PASSIVE")
                iname = item.get("name", item.get("key", "?"))
                ikey = item.get("key")
                if itype not in ("ZABBIX_PASSIVE", "ZABBIX_ACTIVE"):
                    continue
                root_key = (ikey or "").split("[")[0]
                if root_key in AGENT_KEY_MAPPING:
                    metric_name = AGENT_KEY_MAPPING[root_key]
                    if metric_name in existing_metric_names:
                        continue
                    status2, _ = api_call("POST", f"/api/v1/alert-templates/{template_id}/items", token=token, body={
                        "metric_name": metric_name, "data_type": "gauge", "polling_interval_seconds": 60,
                        "is_table": False, "collector_type": "agent", "connection_config": {}
                    })
                    if status2 in (200, 201):
                        report["created_items"] += 1
                        existing_metric_names.add(metric_name)
                        print(f"  [+] {tname}: {metric_name} eklendi")
                    else:
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": "API hatasi (mevcut template)"})
                elif root_key == AGENT_PROC_NUM_KEY:
                    param_match = re.search(r"\[([^,\]]+)", ikey or "")
                    process_name = param_match.group(1) if param_match else None
                    if process_name and "{$" in process_name:
                        # Makro referansı (örn. {$RABBITMQ.PROCESS_NAME}) hiç çözülmeden
                        # geldi - cihaza atanmadan gerçek değeri bilinemez, garanti bozuk
                        # bir item olurdu. Uydurma bir değer atamak yerine ATLA.
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"process adı bir makro referansı ({process_name}), cihaza atanmadan çözülemez"})
                        continue
                    if not process_name:
                        continue
                    metric_name = re.sub(r"[^a-zA-Z0-9_]", "_", f"proc_num_{process_name}")[:60]
                    if metric_name in existing_metric_names:
                        continue
                    status2, _ = api_call("POST", f"/api/v1/alert-templates/{template_id}/items", token=token, body={
                        "metric_name": metric_name, "data_type": "gauge", "polling_interval_seconds": 60,
                        "is_table": False, "collector_type": "agent", "connection_config": {"process_pattern": process_name}
                    })
                    if status2 in (200, 201):
                        report["created_items"] += 1
                        existing_metric_names.add(metric_name)
                        print(f"  [+] {tname}: {metric_name} eklendi")
                    else:
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": "API hatasi (mevcut template)"})
                elif root_key in PLUGIN_KEY_MAPPING or root_key in ("perf_counter_en", "wmi.get", "wmi.getall"):
                    cfg = build_plugin_connection_config(root_key, ikey) if root_key in PLUGIN_KEY_MAPPING else build_windows_connection_config(root_key, ikey)
                    if cfg is None:
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": "parametre cozulemedi ya da makro referansi"})
                        continue
                    metric_name = re.sub(r"[^a-zA-Z0-9_]", "_", (ikey or iname))[:60]
                    if metric_name in existing_metric_names:
                        continue
                    status2, created_item = api_call("POST", f"/api/v1/alert-templates/{template_id}/items", token=token, body={
                        "metric_name": metric_name, "data_type": "gauge", "polling_interval_seconds": 60,
                        "is_table": False, "collector_type": "agent", "connection_config": cfg
                    })
                    if status2 in (200, 201):
                        report["created_items"] += 1
                        existing_metric_names.add(metric_name)
                        print(f"  [+] {tname}: {metric_name} eklendi (plugin: {cfg.get('plugin')})")
                    else:
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"API hatasi: {created_item}"})
                else:
                    report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"agent'ta bu key icin toplama kodu yok ({root_key})"})

            # ---- Trigger'lar (üst seviyeden okunan, bu template'e ait olanlar) ----
            existing_rules = {(r["metric_name"], r["condition"]) for r in (existing_detail or {}).get("rules", [])}
            _, live_scenarios = api_call("GET", f"/api/v1/alert-templates/{template_id}/web-scenarios", token=token)
            live_scenario_steps = {}  # (scenario_name, step_name) -> True
            for sc in (live_scenarios or []):
                _, sc_detail = api_call("GET", f"/api/v1/web-scenarios/{sc['id']}", token=token)
                for step in (sc_detail or {}).get("steps", []):
                    live_scenario_steps[(sc["name"], step["name"])] = True

            for trig in triggers_by_template.get(tname, []):
                expr = trig.get("expression", "")
                tname_trig = trig.get("name", "?")
                tprio = SEVERITY_MAP.get(trig.get("priority", "WARNING"), "warning")

                rule = parse_simple_trigger(expr, key_to_metric_name)
                if rule is not None:
                    rule["severity"] = tprio
                    if (rule["metric_name"], rule["condition"]) in existing_rules:
                        continue  # idempotency -- zaten var
                    status3, _ = api_call("POST", f"/api/v1/alert-templates/{template_id}/rules", token=token, body=rule)
                    if status3 in (200, 201):
                        report["created_rules"] += 1
                        existing_rules.add((rule["metric_name"], rule["condition"]))
                        print(f"  [+] {tname}: kural eklendi ({rule['metric_name']} {rule['condition']} {rule.get('threshold', rule.get('threshold_macro_key'))})")
                    else:
                        report["skipped_triggers"].append({"template": tname, "name": tname_trig, "expression": expr, "reason": "API hatasi"})
                    continue

                web_rule = parse_web_test_trigger(expr)
                if web_rule is not None:
                    key = (web_rule["scenario_name"], web_rule["step_name"])
                    if key not in live_scenario_steps:
                        report["skipped_triggers"].append({"template": tname, "name": tname_trig, "expression": expr, "reason": f"Web Scenario yaniti suresi trigger'i -- hedef senaryo/adim ('{web_rule['scenario_name']}' / '{web_rule['step_name']}') su an canli degil. Gerçek URL ile senaryo olusturulup script tekrar calistirildiginda otomatik eslesecek."})
                        continue
                    metric_name = web_scenario_metric_name(web_rule["scenario_name"], web_rule["step_name"])
                    rule2 = {
                        "metric_name": metric_name, "condition": web_rule["condition"],
                        "duration_seconds": web_rule["duration_seconds"], "severity": tprio,
                    }
                    if "threshold_macro_key" in web_rule:
                        rule2["threshold_macro_key"] = web_rule["threshold_macro_key"]
                        rule2["threshold"] = 0
                    else:
                        rule2["threshold"] = web_rule["threshold"]
                    if (metric_name, rule2["condition"]) in existing_rules:
                        continue
                    status3, _ = api_call("POST", f"/api/v1/alert-templates/{template_id}/rules", token=token, body=rule2)
                    if status3 in (200, 201):
                        report["created_rules"] += 1
                        existing_rules.add((metric_name, rule2["condition"]))
                        print(f"  [+] {tname}: Web Scenario kurali eklendi ({metric_name})")
                    else:
                        report["skipped_triggers"].append({"template": tname, "name": tname_trig, "expression": expr, "reason": "API hatasi (web scenario kurali)"})
                    continue

                report["skipped_triggers"].append({"template": tname, "name": tname_trig, "expression": expr, "reason": "coklu-metrik/mantiksal ifade -- tek metrik+esik modeline uymuyor"})
            continue

        # Tags
        tags = [f"{tag['tag']}:{tag.get('value', '')}" for tag in t.get("tags", [])]

        print(f"[OLUŞTUR] Template: {tname}")
        status, created = api_call("POST", "/api/v1/alert-templates", token=token, body={
            "name": tname, "tags": tags, "rules": []
        })
        if status not in (200, 201):
            print(f"  HATA: template oluşturulamadı ({status}): {created}")
            report["skipped_templates"].append({"name": tname, "reason": str(created)})
            continue

        template_id = created["id"]
        report["created_templates"].append(tname)

        # ---- Macros ----
        for m in t.get("macros", []):
            macro_key = m["macro"]
            if ":" in macro_key:
                report["skipped_macros"].append({"template": tname, "macro": macro_key, "reason": "context'li makro (desteklenmiyor)"})
                continue
            value = m.get("value", "0")
            try:
                float(value)
                value_type = "numeric"
            except ValueError:
                value_type = "string"
            status, _ = api_call("POST", "/api/v1/macros", token=token, body={
                "key": macro_key, "default_value": value if value_type == "numeric" else 0,
                "description": m.get("description", "")
            })
            # Not: makrolar tenant genelinde tekil (global) olduğu için "zaten var" (409) beklenen bir durumdur.
            if status in (200, 201):
                report["created_macros"] += 1

        # ---- Items ----
        key_to_metric_name = {}
        key_to_item_id = {}
        master_key_to_id = {}

        importable_items = [i for i in t.get("items", []) if i.get("type") in ("SNMP_AGENT", "SIMPLE", "HTTP_AGENT", "DEPENDENT", "ZABBIX_PASSIVE", "ZABBIX_ACTIVE")]
        # DEPENDENT item'lar, master'ları önce oluşturulmuş olmalı — sırala: önce master olmayanlar
        importable_items.sort(key=lambda i: 1 if i.get("type") == "DEPENDENT" else 0)
        for item in t.get("items", []):
            itype = item.get("type", "ZABBIX_PASSIVE")
            iname = item.get("name", item.get("key", "?"))
            ikey = item.get("key")

            # Faz E sonrasi eklenen agent-tipi item eslemesi.
            if itype in ("ZABBIX_PASSIVE", "ZABBIX_ACTIVE"):
                root_key = (ikey or "").split("[")[0]
                if root_key in AGENT_KEY_MAPPING:
                    metric_name = AGENT_KEY_MAPPING[root_key]
                    status, created_item = api_call("POST", f"/api/v1/alert-templates/{template_id}/items", token=token, body={
                        "metric_name": metric_name, "data_type": "gauge", "polling_interval_seconds": 60,
                        "is_table": False, "collector_type": "agent", "connection_config": {}
                    })
                    if status in (200, 201):
                        report["created_items"] += 1
                    else:
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"API hatasi: {created_item}"})
                    continue
                elif root_key == AGENT_PROC_NUM_KEY:
                    param_match = re.search(r"\[([^,\]]+)", ikey or "")
                    process_name = param_match.group(1) if param_match else None
                    if process_name and "{$" in process_name:
                        # Makro referansı (örn. {$RABBITMQ.PROCESS_NAME}) hiç çözülmeden
                        # geldi - cihaza atanmadan gerçek değeri bilinemez, garanti bozuk
                        # bir item olurdu. Uydurma bir değer atamak yerine ATLA.
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"process adı bir makro referansı ({process_name}), cihaza atanmadan çözülemez"})
                        continue
                    if not process_name:
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": "proc.num parametresi cozulemedi"})
                        continue
                    metric_name = re.sub(r"[^a-zA-Z0-9_]", "_", f"proc_num_{process_name}")[:60]
                    status, created_item = api_call("POST", f"/api/v1/alert-templates/{template_id}/items", token=token, body={
                        "metric_name": metric_name, "data_type": "gauge", "polling_interval_seconds": 60,
                        "is_table": False, "collector_type": "agent", "connection_config": {"process_pattern": process_name}
                    })
                    if status in (200, 201):
                        report["created_items"] += 1
                    else:
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"API hatasi: {created_item}"})
                    continue
                elif root_key in PLUGIN_KEY_MAPPING or root_key in ("perf_counter_en", "wmi.get", "wmi.getall"):
                    cfg = build_plugin_connection_config(root_key, ikey) if root_key in PLUGIN_KEY_MAPPING else build_windows_connection_config(root_key, ikey)
                    if cfg is None:
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": "parametre cozulemedi ya da makro referansi"})
                        continue
                    metric_name = re.sub(r"[^a-zA-Z0-9_]", "_", (ikey or iname))[:60]
                    status, created_item = api_call("POST", f"/api/v1/alert-templates/{template_id}/items", token=token, body={
                        "metric_name": metric_name, "data_type": "gauge", "polling_interval_seconds": 60,
                        "is_table": False, "collector_type": "agent", "connection_config": cfg
                    })
                    if status in (200, 201):
                        report["created_items"] += 1
                        print(f"  [+] {tname}: {metric_name} eklendi (plugin: {cfg.get('plugin')})")
                    else:
                        report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"API hatasi: {created_item}"})
                    continue
                else:
                    report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"agent'ta bu key icin toplama kodu yok ({root_key}) - ayri bir collector modulu gerektirir"})
                    continue

            if itype not in ("SNMP_AGENT", "SIMPLE", "HTTP_AGENT", "DEPENDENT"):
                report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": "desteklenmeyen collector tipi"})
                continue

            if itype not in ("SNMP_AGENT", "SIMPLE", "HTTP_AGENT", "DEPENDENT"):
                report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": "desteklenmeyen collector tipi"})
                continue

            metric_name = re.sub(r"[^a-zA-Z0-9_]", "_", ikey or iname)[:60]

            body = {"metric_name": metric_name, "data_type": "gauge", "polling_interval_seconds": 60, "is_table": False}

            if itype == "SNMP_AGENT":
                oid = item.get("snmp_oid", "")
                if "{#" in oid:  # LLD tablo item'ı, otomatik eşleme riskli — atla
                    report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": "LLD/tablo item (manuel inceleme gerekli)"})
                    continue
                body["collector_type"] = "snmp"
                body["oid"] = oid

            elif itype == "SIMPLE":
                if ikey and ikey.startswith("icmpping"):
                    body["collector_type"] = "icmp_ping"
                    body["connection_config"] = {}
                elif ikey and ikey.startswith("net.tcp.service"):
                    port_match = re.search(r",(\d+)\]?$", ikey)
                    body["collector_type"] = "tcp_port"
                    body["connection_config"] = {"port": int(port_match.group(1)) if port_match else 0}
                else:
                    report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"desteklenmeyen SIMPLE check ({ikey})"})
                    continue

            elif itype == "HTTP_AGENT":
                url = item.get("url", "")
                if not url:
                    report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": "url tanımlı değil"})
                    continue
                body["collector_type"] = "http_json"
                body["connection_config"] = {"url": url, "method": "GET"}

            elif itype == "DEPENDENT":
                master_key = item.get("master_item", {}).get("key")
                master_id = master_key_to_id.get(master_key)
                if not master_id:
                    report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"master item bulunamadı ({master_key})"})
                    continue
                jsonpath = None
                for pp in item.get("preprocessing", []):
                    if pp.get("type") == "JSONPATH":
                        jsonpath = pp.get("parameters", [None])[0]
                        break
                body["collector_type"] = "http_json"  # dependent'lar genelde HTTP master'a bağlı
                body["connection_config"] = {"json_path": jsonpath.lstrip("$.") if jsonpath else None}
                body["master_item_id"] = master_id

            status, created_item = api_call("POST", f"/api/v1/alert-templates/{template_id}/items", token=token, body=body)
            if status in (200, 201):
                report["created_items"] += 1
                if ikey:
                    key_to_metric_name[ikey] = metric_name
                    key_to_item_id[ikey] = created_item["id"]
                    master_key_to_id[ikey] = created_item["id"]
            else:
                report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": str(created_item)})

        # ---- Triggers (item içine gömülü) ----
        for item in t.get("items", []):
            for trig in item.get("triggers", []):
                expr = trig.get("expression", "")
                rule = parse_simple_trigger(expr, key_to_metric_name)
                tprio = SEVERITY_MAP.get(trig.get("priority", "WARNING"), "warning")
                if rule is None:
                    report["skipped_triggers"].append({"template": tname, "name": trig.get("name"), "expression": expr, "reason": "karmaşık/çok-fonksiyonlu ifade"})
                    continue
                rule["severity"] = tprio
                status, _ = api_call("POST", f"/api/v1/alert-templates/{template_id}/rules", token=token, body=rule)
                if status in (200, 201):
                    report["created_rules"] += 1
                else:
                    report["skipped_triggers"].append({"template": tname, "name": trig.get("name"), "expression": expr, "reason": "API hatası"})

        # ---- Web Scenarios (httptests) ----
        for ht in t.get("httptests", []):
            steps = []
            for step in ht.get("steps", []):
                steps.append({
                    "name": step.get("name", "adım"),
                    "url": step.get("url", ""),
                    "expected_status_code": int(step.get("status_codes", "200").split(",")[0]) if step.get("status_codes") else 200
                })
            if not steps:
                continue
            status, _ = api_call("POST", f"/api/v1/alert-templates/{template_id}/web-scenarios", token=token, body={
                "name": ht.get("name", "Web Scenario"),
                "polling_interval_seconds": 300,
                "steps": steps
            })
            if status in (200, 201):
                report["created_scenarios"] += 1

    # ============ RAPOR ============
    print("\n" + "=" * 60)
    print("İMPORT RAPORU")
    print("=" * 60)
    print(f"Oluşturulan template: {len(report['created_templates'])}")
    print(f"Atlanan template: {len(report['skipped_templates'])}")
    print(f"Oluşturulan item: {report['created_items']}")
    print(f"Atlanan item: {len(report['skipped_items'])}")
    print(f"Oluşturulan makro: {report['created_macros']}")
    print(f"Atlanan makro (context'li): {len(report['skipped_macros'])}")
    print(f"Oluşturulan alarm kuralı: {report['created_rules']}")
    print(f"Atlanan trigger (karmaşık ifade): {len(report['skipped_triggers'])}")
    print(f"Oluşturulan Web Scenario: {report['created_scenarios']}")

    with open("import_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\nDetaylı rapor: import_report.json")


if __name__ == "__main__":
    main()
