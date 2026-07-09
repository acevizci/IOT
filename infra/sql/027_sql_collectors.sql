INSERT INTO collector_types (key, display_name, category, config_schema, handler_service) VALUES
  ('sql_postgres', 'PostgreSQL Sorgusu', 'database', '{"fields":["connection_string","query"]}', 'sql-collector'),
  ('sql_mysql', 'MySQL Sorgusu', 'database', '{"fields":["connection_string","query"]}', 'sql-collector')
ON CONFLICT (key) DO NOTHING;
