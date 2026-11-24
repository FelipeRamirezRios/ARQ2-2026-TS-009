-- AeroBooking Enterprise: CQRS read model, event store, PNR and ticket lifecycle.
CREATE TABLE IF NOT EXISTS booking_events (
  event_id BIGSERIAL PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES bookings(booking_id),
  event_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, event_version)
);
CREATE INDEX IF NOT EXISTS booking_events_booking_idx ON booking_events(booking_id,event_version);
CREATE TABLE IF NOT EXISTS pnr_records (
  pnr_code VARCHAR(8) PRIMARY KEY,
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(booking_id),
  agency_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED','EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS booking_read_model (
  booking_id UUID PRIMARY KEY REFERENCES bookings(booking_id),
  pnr_code VARCHAR(8), agency_id UUID NOT NULL, flight_id TEXT NOT NULL,
  seat_number TEXT NOT NULL, status TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL,
  currency CHAR(3) NOT NULL, airline_confirmation_code TEXT,
  airline_reason TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_read_model_agency_idx ON booking_read_model(agency_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS booking_passengers (
  passenger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  document_reference_hash TEXT,
  passenger_type TEXT NOT NULL DEFAULT 'ADT' CHECK (passenger_type IN ('ADT','CHD','INF')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tickets (
  ticket_number VARCHAR(20) PRIMARY KEY,
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(booking_id),
  pnr_code VARCHAR(8) NOT NULL REFERENCES pnr_records(pnr_code),
  status TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','VOID','REFUNDED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(), voided_at TIMESTAMPTZ
);
ALTER TABLE purchase_saga ADD COLUMN IF NOT EXISTS idempotency_hash TEXT;
CREATE OR REPLACE FUNCTION aerobooking_pnr_code() RETURNS TEXT AS $$
  SELECT upper(substr(encode(gen_random_bytes(5),'hex'),1,6));
$$ LANGUAGE SQL VOLATILE;
CREATE OR REPLACE FUNCTION maintain_booking_read_model() RETURNS trigger AS $$
DECLARE next_version INTEGER; pnr TEXT;
BEGIN
  SELECT COALESCE(MAX(event_version),0)+1 INTO next_version FROM booking_events WHERE booking_id=NEW.booking_id;
  IF TG_OP='INSERT' THEN
    pnr := aerobooking_pnr_code();
    INSERT INTO pnr_records(pnr_code,booking_id,agency_id) VALUES(pnr,NEW.booking_id,NEW.agency_id) ON CONFLICT(booking_id) DO NOTHING;
    SELECT pnr_code INTO pnr FROM pnr_records WHERE booking_id=NEW.booking_id;
    INSERT INTO booking_events(booking_id,event_version,event_type,payload)
      VALUES(NEW.booking_id,next_version,'booking.created',jsonb_build_object('status',NEW.status,'agencyId',NEW.agency_id,'flightId',NEW.flight_id,'seatNumber',NEW.seat_number,'amount',NEW.amount,'currency',NEW.currency,'pnr',pnr));
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT pnr_code INTO pnr FROM pnr_records WHERE booking_id=NEW.booking_id;
    INSERT INTO booking_events(booking_id,event_version,event_type,payload)
      VALUES(NEW.booking_id,next_version,'booking.status_changed',jsonb_build_object('from',OLD.status,'to',NEW.status,'status',NEW.status,'pnr',pnr,'agencyId',NEW.agency_id,'flightId',NEW.flight_id,'seatNumber',NEW.seat_number,'amount',NEW.amount,'currency',NEW.currency,'confirmationCode',NEW.airline_confirmation_code,'reason',NEW.airline_reason,'updatedAt',NEW.updated_at));
    IF NEW.status='CONFIRMED' THEN
      INSERT INTO tickets(ticket_number,booking_id,pnr_code) VALUES('ETK-'||upper(substr(replace(NEW.booking_id::text,'-',''),1,13)),NEW.booking_id,pnr)
      ON CONFLICT(booking_id) DO NOTHING;
      IF FOUND THEN
        INSERT INTO booking_events(booking_id,event_version,event_type,payload)
          VALUES(NEW.booking_id,next_version+1,'ticket.issued',jsonb_build_object('pnr',pnr,'ticketNumber','ETK-'||upper(substr(replace(NEW.booking_id::text,'-',''),1,13))));
      END IF;
    ELSIF NEW.status IN ('CANCELLED','COMPENSATED') THEN
      UPDATE pnr_records SET status='CANCELLED',updated_at=now() WHERE booking_id=NEW.booking_id;
      UPDATE tickets SET status='VOID',voided_at=now() WHERE booking_id=NEW.booking_id AND status='ISSUED';
      IF FOUND THEN
        INSERT INTO booking_events(booking_id,event_version,event_type,payload)
          VALUES(NEW.booking_id,next_version+1,'ticket.voided',jsonb_build_object('pnr',pnr,'reason',NEW.airline_reason));
      END IF;
    END IF;
  END IF;
  SELECT pnr_code INTO pnr FROM pnr_records WHERE booking_id=NEW.booking_id;
  INSERT INTO booking_read_model(booking_id,pnr_code,agency_id,flight_id,seat_number,status,amount,currency,airline_confirmation_code,airline_reason,updated_at)
    VALUES(NEW.booking_id,pnr,NEW.agency_id,NEW.flight_id,NEW.seat_number,NEW.status,NEW.amount,NEW.currency,NEW.airline_confirmation_code,NEW.airline_reason,NEW.updated_at)
  ON CONFLICT(booking_id) DO UPDATE SET pnr_code=EXCLUDED.pnr_code,status=EXCLUDED.status,
    airline_confirmation_code=EXCLUDED.airline_confirmation_code,airline_reason=EXCLUDED.airline_reason,updated_at=EXCLUDED.updated_at;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS booking_cqrs_event_trigger ON bookings;
CREATE TRIGGER booking_cqrs_event_trigger AFTER INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION maintain_booking_read_model();
-- Backfill existing records in a safe, repeatable way.
INSERT INTO pnr_records(pnr_code,booking_id,agency_id)
SELECT aerobooking_pnr_code(),b.booking_id,b.agency_id FROM bookings b
LEFT JOIN pnr_records p ON p.booking_id=b.booking_id WHERE p.booking_id IS NULL ON CONFLICT DO NOTHING;
INSERT INTO booking_read_model(booking_id,pnr_code,agency_id,flight_id,seat_number,status,amount,currency,airline_confirmation_code,airline_reason,updated_at)
SELECT b.booking_id,p.pnr_code,b.agency_id,b.flight_id,b.seat_number,b.status,b.amount,b.currency,b.airline_confirmation_code,b.airline_reason,b.updated_at
FROM bookings b JOIN pnr_records p ON p.booking_id=b.booking_id ON CONFLICT(booking_id) DO NOTHING;
INSERT INTO booking_events(booking_id,event_version,event_type,payload)
SELECT b.booking_id,1,'booking.snapshot_imported',jsonb_build_object('status',b.status,'pnr',p.pnr_code,'agencyId',b.agency_id,'flightId',b.flight_id,'seatNumber',b.seat_number,'amount',b.amount,'currency',b.currency,'confirmationCode',b.airline_confirmation_code,'reason',b.airline_reason,'updatedAt',b.updated_at)
FROM bookings b JOIN pnr_records p ON p.booking_id=b.booking_id
WHERE NOT EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id=b.booking_id) ON CONFLICT DO NOTHING;
INSERT INTO tickets(ticket_number,booking_id,pnr_code)
SELECT 'ETK-'||upper(substr(replace(b.booking_id::text,'-',''),1,13)),b.booking_id,p.pnr_code
FROM bookings b JOIN pnr_records p ON p.booking_id=b.booking_id
WHERE b.status='CONFIRMED' ON CONFLICT(booking_id) DO NOTHING;
INSERT INTO booking_events(booking_id,event_version,event_type,payload)
SELECT t.booking_id,(SELECT COALESCE(MAX(e.event_version),0)+1 FROM booking_events e WHERE e.booking_id=t.booking_id),
  'ticket.issued',jsonb_build_object('pnr',t.pnr_code,'ticketNumber',t.ticket_number)
FROM tickets t WHERE NOT EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id=t.booking_id AND e.event_type='ticket.issued')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION prevent_booking_event_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'booking_events is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS block_booking_event_mutation ON booking_events;
CREATE TRIGGER block_booking_event_mutation BEFORE UPDATE OR DELETE ON booking_events FOR EACH ROW EXECUTE FUNCTION prevent_booking_event_mutation();

-- Rebuild the CQRS read side from the latest state-bearing event for every booking.
CREATE OR REPLACE FUNCTION rebuild_booking_read_model() RETURNS INTEGER AS $$
DECLARE rebuilt INTEGER;
BEGIN
  WITH latest_state AS (
    SELECT DISTINCT ON (booking_id) booking_id,payload
    FROM booking_events
    WHERE event_type IN ('booking.created','booking.status_changed','booking.snapshot_imported')
    ORDER BY booking_id,event_version DESC
  )
  INSERT INTO booking_read_model(booking_id,pnr_code,agency_id,flight_id,seat_number,status,amount,currency,airline_confirmation_code,airline_reason,updated_at)
  SELECT booking_id,payload->>'pnr',(payload->>'agencyId')::uuid,payload->>'flightId',payload->>'seatNumber',payload->>'status',
    (payload->>'amount')::numeric,payload->>'currency',payload->>'confirmationCode',payload->>'reason',COALESCE((payload->>'updatedAt')::timestamptz,now())
  FROM latest_state
  ON CONFLICT(booking_id) DO UPDATE SET pnr_code=EXCLUDED.pnr_code,agency_id=EXCLUDED.agency_id,flight_id=EXCLUDED.flight_id,
    seat_number=EXCLUDED.seat_number,status=EXCLUDED.status,amount=EXCLUDED.amount,currency=EXCLUDED.currency,
    airline_confirmation_code=EXCLUDED.airline_confirmation_code,airline_reason=EXCLUDED.airline_reason,updated_at=EXCLUDED.updated_at;
  GET DIAGNOSTICS rebuilt = ROW_COUNT;
  RETURN rebuilt;
END; $$ LANGUAGE plpgsql;
