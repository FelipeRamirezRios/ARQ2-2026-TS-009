const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hashBookingRequest, idempotencyReplay, canIssueTicket, ticketNumber } = require('../packages/enterprise');
const root = path.resolve(__dirname, '..');

test('CQRS/Event Sourcing migration defines event store and read projection', () => {
  const sql = fs.readFileSync(path.join(root, 'infrastructure/postgres/migrations/003-enterprise.sql'), 'utf8');
  for (const token of ['booking_events', 'booking_read_model', 'maintain_booking_read_model', 'booking.status_changed']) assert.match(sql, new RegExp(token));
  assert.match(sql, /CREATE TRIGGER booking_cqrs_event_trigger/);
});
test('PNR and e-ticket schema enforces one PNR and ticket per booking', () => {
  const sql = fs.readFileSync(path.join(root, 'infrastructure/postgres/migrations/003-enterprise.sql'), 'utf8');
  assert.match(sql, /pnr_code VARCHAR\(8\) PRIMARY KEY/);
  assert.match(sql, /booking_id UUID NOT NULL UNIQUE REFERENCES bookings/);
  assert.match(sql, /ticket_number VARCHAR\(20\) PRIMARY KEY/);
  assert.match(sql, /CHECK \(status IN \('ISSUED','VOID','REFUNDED'\)\)/);
});
test('same idempotency key and same payload is replay-safe', () => {
  const req = { flightId: 'AB123', seatNumber: '14A', fareQuoteId: 'q-1', paymentMethodId: 'agency-wallet' };
  const hash = hashBookingRequest(req);
  assert.equal(hash, hashBookingRequest(req));
  assert.deepEqual(idempotencyReplay(hash, hash), { allowed: true, status: 200, replayed: true });
});
test('same idempotency key with a different payload is rejected', () => {
  const a = hashBookingRequest({ flightId: 'AB123', seatNumber: '14A', fareQuoteId: 'q-1', paymentMethodId: 'wallet' });
  const b = hashBookingRequest({ flightId: 'AB123', seatNumber: '14B', fareQuoteId: 'q-1', paymentMethodId: 'wallet' });
  assert.equal(idempotencyReplay(a, b).status, 409);
  assert.equal(idempotencyReplay(a, b).error, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
});
test('ticket issuance only allowed after airline-confirmed booking', () => {
  assert.equal(canIssueTicket('CONFIRMED'), true);
  for (const state of ['PENDING', 'COMPENSATED', 'REJECTED', 'CANCELLED']) assert.equal(canIssueTicket(state), false);
});
test('ticket number is deterministic for retry safety', () => {
  const id = '00000000-0000-4000-8000-000000000009';
  assert.equal(ticketNumber(id), ticketNumber(id));
  assert.match(ticketNumber(id), /^ETK-[A-F0-9]{13}$/);
});
test('API contract documents v1 and v2 booking resources', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'contracts/openapi.json'), 'utf8'));
  assert.ok(spec.paths['/v1/bookings']);
  assert.ok(spec.paths['/v2/bookings']);
  assert.ok(spec.paths['/v2/bookings/{bookingId}']);
  assert.ok(spec.paths['/v2/admin/projections/rebuild']);
  assert.ok(spec.paths['/v1/pnrs/{pnr}']);
  assert.ok(spec.paths['/v1/tickets/{ticketNumber}/void']);
});
test('Kong routes expose enterprise v2 and PNR/ticket endpoints', () => {
  const kong = JSON.parse(fs.readFileSync(path.join(root, 'gateway/kong/kong.json'), 'utf8'));
  const routes = kong.services.find(s => s.name === 'booking-service').routes.flatMap(r => r.paths);
  for (const route of ['/v2/bookings', '/v2/admin/projections', '/v1/pnrs', '/v1/tickets']) assert.ok(routes.includes(route), route);
});
test('fresh-install schema includes Enterprise migration and immutable event guard', () => {
  const init = fs.readFileSync(path.join(root, 'infrastructure/postgres/init.sql'), 'utf8');
  assert.match(init, /CREATE TABLE IF NOT EXISTS booking_events/);
  assert.match(init, /prevent_booking_event_mutation/);
});
test('backup, restore, chaos and k6 assets are included', () => {
  for (const file of ['scripts/backup.ps1', 'scripts/restore.ps1', 'scripts/backup.sh', 'scripts/restore.sh', 'scripts/chaos-airline.ps1', 'scripts/start-local.ps1', 'load/booking-read.js'])
    assert.ok(fs.existsSync(path.join(root, file)), file);
});
test('Enterprise Grafana dashboard visualizes event, outbox, reconciliation and ticket metrics', () => {
  const dashboard = JSON.parse(fs.readFileSync(path.join(root, 'infrastructure/grafana/provisioning/dashboards/aerobooking-enterprise.json'), 'utf8'));
  const queries = dashboard.panels.flatMap(p => p.targets || []).map(t => t.expr).join('\n');
  for (const metric of ['aerobooking_domain_events_total', 'aerobooking_outbox_unpublished', 'aerobooking_reconciliation_findings_total', 'aerobooking_ticket_operations_total']) assert.ok(queries.includes(metric));
});

test('Docker Compose applies Enterprise migration before booking-service starts', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /db-migrate:/);
  assert.match(compose, /003-enterprise\.sql/);
  assert.match(compose, /db-migrate: \{condition: service_completed_successfully\}/);
  const bootstrap = fs.readFileSync(path.join(root, 'scripts/bootstrap.js'), 'utf8');
  assert.match(bootstrap, /'\/v2\/admin\/projections'/);
});
test('booking service exposes tenant-scoped CQRS, PNR, passenger and ticket endpoints', () => {
  const source = fs.readFileSync(path.join(root, 'services/booking/enterprise.js'), 'utf8');
  for (const route of ["app.get('/v2/bookings'", "app.get('/v2/bookings/:bookingId'", "app.get('/v2/bookings/:bookingId/events'", "app.get('/v1/pnrs/:pnr'", "app.post('/v1/bookings/:bookingId/passengers'", "app.post('/v1/bookings/:bookingId/tickets/issue'", "app.post('/v1/tickets/:ticketNumber/void'"]) assert.ok(source.includes(route), route);
  assert.match(source, /WHERE agency_id=\$1/);
  assert.match(source, /document_reference_hash/);
});
test('booking idempotency rejects payload drift and handles uniqueness races', () => {
  const source = fs.readFileSync(path.join(root, 'services/booking/index.js'), 'utf8');
  assert.match(source, /idempotencyReplay\(existing\.rows\[0\]\.idempotency_hash,requestHash\)/);
  assert.match(source, /err\.code==='23505'/);
  assert.match(source, /idempotency_hash/);
});
