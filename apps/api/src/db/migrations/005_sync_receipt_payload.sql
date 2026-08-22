-- A duplicate batch is a normal consequence of an interrupted response. Keep the
-- original accepted-event list so a participant device can verify the same
-- acknowledgement after retrying, rather than accepting an unverifiable hash.
ALTER TABLE research.sync_receipts
  ADD COLUMN IF NOT EXISTS accepted jsonb NOT NULL DEFAULT '[]'::jsonb;
