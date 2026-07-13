-- Faz E Aşama 5: Agent kendi kendini güncelleme — her platform için ayrı, en güncel
-- sürüm bilgisi (checksum ile doğrulanabilir).
CREATE TABLE IF NOT EXISTS agent_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL,
    platform TEXT NOT NULL, -- 'linux_amd64', 'linux_arm64', 'windows_amd64' vs.
    file_path TEXT NOT NULL, -- sunucudaki yerel dosya yolu
    sha256_checksum TEXT NOT NULL,
    released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(platform, version)
);
