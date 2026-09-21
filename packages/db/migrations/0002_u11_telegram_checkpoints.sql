-- 0002 (unit 11): per-channel cursor of the live Telegram collector.
-- pts is Telegram's channel update sequence number. It is written in the same transaction as the
-- messages up to it, so a crash before commit never moves the cursor past unsaved data.
CREATE TABLE telegram_checkpoints (
  source_id uuid PRIMARY KEY REFERENCES sources (id),
  pts integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
