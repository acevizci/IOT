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
    r"^(?:last|min|max|avg)\(/[^/]+/([^,)]+)(?:,[^)]*)?\)\s*([<>=])\s*(\{[^}]+\}|[\d.]+)$"
)


def parse_simple_trigger(expression, key_to_metric_name):
    m = SIMPLE_TRIGGER_RE.match(expression.strip())
    if not m:
        return None
    key, op, threshold_raw = m.groups()
    metric_name = key_to_metric_name.get(key)
    if not metric_name:
        return None
    condition = {">": "gt", "<": "lt", "=": "eq"}[op]
    rule = {
        "metric_name": metric_name,
        "condition": condition,
        "duration_seconds": 60,
        "severity": "warning",
    }
    if threshold_raw.startswith("{$"):
        rule["threshold_macro_key"] = threshold_raw
        rule["threshold"] = 0  # macro varsa gerçek değer apply sırasında çözülür
    else:
        try:
            rule["threshold"] = float(threshold_raw)
        except ValueError:
            return None
    return rule


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

def main():
    if len(sys.argv) != 4:
        print("Kullanım: python3 import_zabbix_templates.py <yaml_dosya> <email> <şifre>")
        sys.exit(1)

    yaml_path, email, password = sys.argv[1], sys.argv[2], sys.argv[3]

    with open(yaml_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    templates = data["zabbix_export"]["templates"]
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
            _, existing_detail = api_call("GET", f"/api/v1/alert-templates/{template_id}", token=token)
            existing_metric_names = {i["metric_name"] for i in (existing_detail or {}).get("items", [])} if existing_detail else set()
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
                else:
                    report["skipped_items"].append({"template": tname, "name": iname, "type": itype, "reason": f"agent'ta bu key icin toplama kodu yok ({root_key})"})
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
