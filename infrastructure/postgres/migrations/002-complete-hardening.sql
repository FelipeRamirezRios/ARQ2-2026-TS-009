-- Safe additive migration for existing AeroBooking databases.
BEGIN;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox(available_at,id) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ, status TEXT NOT NULL, findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  initiated_by UUID, correlation_id UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS reconciliation_runs_started_idx ON reconciliation_runs(started_at DESC);
COMMIT;
