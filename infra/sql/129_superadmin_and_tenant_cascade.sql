-- Platform superadmin + tenant silme desteği (kullanıcıyla konuşulup kararlaştırıldı):
-- mevcut yetki modeli TAMAMEN tenant-scoped (bir kullanıcının JWT'si kendi tenant_id'sine
-- kilitli, her sorgu WHERE tenant_id = auth.tenantId). "Tüm tenant'ları listele/sil" cross-
-- tenant bir yetenek olduğu için normal Admin rolünden TAMAMEN AYRI, yeni bir bayrak gerekiyor.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false;

-- Bootstrap: bu ortamda gerçekten kullanılan hesap (kullanıcıyla konuşulup teyit edildi).
UPDATE users SET is_superadmin = true WHERE email = 'snmp2@test.com';

-- Tenant silme cascade -- canlı DB'nin information_schema'sından ÜRETİLEN, doğrulanmış
-- liste (28 tablo tenants(id)'ye referans veriyordu, sadece 3'ü zaten CASCADE'ti). Bu
-- olmadan `DELETE FROM tenants` foreign key ihlaliyle patlar. GERÇEK EKSİKLİK DÜZELTMESİ:
-- proxy_metric_batches ayrıca proxy_id -> proxies(id) üzerinden NO ACTION idi VE kendi
-- tenant_id kolonu YOK -- proxies tenant cascade'iyle silinirken bu tablo yakalanmıyordu,
-- ayrı bir CASCADE fix'i gerekiyor (aşağıda, en sonda).
ALTER TABLE agent_registration_tokens DROP CONSTRAINT IF EXISTS agent_registration_tokens_tenant_id_fkey;
ALTER TABLE agent_registration_tokens ADD CONSTRAINT agent_registration_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_tenant_id_fkey;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE alert_templates DROP CONSTRAINT IF EXISTS alert_templates_tenant_id_fkey;
ALTER TABLE alert_templates ADD CONSTRAINT alert_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_tenant_id_fkey;
ALTER TABLE alerts ADD CONSTRAINT alerts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE api_tokens DROP CONSTRAINT IF EXISTS api_tokens_tenant_id_fkey;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_tenant_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_tenant_id_fkey;
ALTER TABLE dashboards ADD CONSTRAINT dashboards_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE device_groups DROP CONSTRAINT IF EXISTS device_groups_tenant_id_fkey;
ALTER TABLE device_groups ADD CONSTRAINT device_groups_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE device_links DROP CONSTRAINT IF EXISTS device_links_tenant_id_fkey;
ALTER TABLE device_links ADD CONSTRAINT device_links_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_tenant_id_fkey;
ALTER TABLE devices ADD CONSTRAINT devices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE escalation_policies DROP CONSTRAINT IF EXISTS escalation_policies_tenant_id_fkey;
ALTER TABLE escalation_policies ADD CONSTRAINT escalation_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_tenant_id_fkey;
ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE macros DROP CONSTRAINT IF EXISTS macros_tenant_id_fkey;
ALTER TABLE macros ADD CONSTRAINT macros_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE maintenance_windows DROP CONSTRAINT IF EXISTS maintenance_windows_tenant_id_fkey;
ALTER TABLE maintenance_windows ADD CONSTRAINT maintenance_windows_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE media_types DROP CONSTRAINT IF EXISTS media_types_tenant_id_fkey;
ALTER TABLE media_types ADD CONSTRAINT media_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE metric_value_maps DROP CONSTRAINT IF EXISTS metric_value_maps_tenant_id_fkey;
ALTER TABLE metric_value_maps ADD CONSTRAINT metric_value_maps_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE oncall_schedules DROP CONSTRAINT IF EXISTS oncall_schedules_tenant_id_fkey;
ALTER TABLE oncall_schedules ADD CONSTRAINT oncall_schedules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE proxies DROP CONSTRAINT IF EXISTS proxies_tenant_id_fkey;
ALTER TABLE proxies ADD CONSTRAINT proxies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE proxy_registration_tokens DROP CONSTRAINT IF EXISTS proxy_registration_tokens_tenant_id_fkey;
ALTER TABLE proxy_registration_tokens ADD CONSTRAINT proxy_registration_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE suppressed_alerts DROP CONSTRAINT IF EXISTS suppressed_alerts_tenant_id_fkey;
ALTER TABLE suppressed_alerts ADD CONSTRAINT suppressed_alerts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE topology_positions DROP CONSTRAINT IF EXISTS topology_positions_tenant_id_fkey;
ALTER TABLE topology_positions ADD CONSTRAINT topology_positions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE traffic_links DROP CONSTRAINT IF EXISTS traffic_links_tenant_id_fkey;
ALTER TABLE traffic_links ADD CONSTRAINT traffic_links_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_tenant_id_fkey;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tenant_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE value_maps DROP CONSTRAINT IF EXISTS value_maps_tenant_id_fkey;
ALTER TABLE value_maps ADD CONSTRAINT value_maps_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- proxy_metric_batches'in kendi tenant_id'si yok (sadece proxy_id var) -- proxies
-- tenant cascade'iyle silinirken bu tablo yakalanmıyordu, ayrı bir CASCADE gerekiyor.
ALTER TABLE proxy_metric_batches DROP CONSTRAINT IF EXISTS proxy_metric_batches_proxy_id_fkey;
ALTER TABLE proxy_metric_batches ADD CONSTRAINT proxy_metric_batches_proxy_id_fkey FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE;
