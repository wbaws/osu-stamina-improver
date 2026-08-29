ALTER TABLE players ADD COLUMN key TEXT;
UPDATE players SET key = LOWER(TRIM(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_key ON players (key);
