const crypto = require('node:crypto');
const { canIssueTicket, ticketNumber } = require('../../packages/enterprise');
const prom = require('prom-client');

function registerEnterpriseRoutes(app, deps) {
  const { pool, requireAuth, requireScope, audit } = deps;
  const eventsAppended = new prom.Counter({ name: 'aerobooking_domain_events_total', help: 'Domain events stored in the booking event store', labelNames: ['event_type'] });
  const ticketOperations = new prom.Counter({ name: 'aerobooking_ticket_operations_total', help: 'Ticket issuance and void operations', labelNames: ['operation', 'result'] });
  const pnrLookups = new prom.Counter({ name: 'aerobooking_pnr_lookups_total', help: 'PNR lookup operations', labelNames: ['result'] });

  // CQRS collection endpoint: tenant-scoped pagination over the read projection.
  app.get('/v2/bookings', requireAuth, requireScope('bookings:read'), async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '25', 10) || 25));
    const offset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0);
    const [items, total] = await Promise.all([
      pool.query(`SELECT booking_id AS "bookingId",pnr_code AS "pnr",flight_id AS "flightId",seat_number AS "seatNumber",status,amount,currency,updated_at AS "updatedAt"
        FROM booking_read_model WHERE agency_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`, [req.actor.agencyId, limit, offset]),
      pool.query('SELECT count(*)::int AS total FROM booking_read_model WHERE agency_id=$1', [req.actor.agencyId])
    ]);
    return res.json({ apiVersion: 'v2', items: items.rows, total: total.rows[0].total, limit, offset });
  });

  // CQRS v2 query endpoint: reads from the projection, not the transactional aggregate.
  app.get('/v2/bookings/:bookingId', requireAuth, requireScope('bookings:read'), async (req, res) => {
    const { rows } = await pool.query(`SELECT r.booking_id AS "bookingId",r.pnr_code AS "pnr",r.flight_id AS "flightId",
      r.seat_number AS "seatNumber",r.status,r.amount,r.currency,r.airline_confirmation_code AS "airlineConfirmationCode",
      r.airline_reason AS reason,r.updated_at AS "updatedAt",t.ticket_number AS "ticketNumber",t.status AS "ticketStatus"
      FROM booking_read_model r LEFT JOIN tickets t ON t.booking_id=r.booking_id
      WHERE r.booking_id=$1 AND r.agency_id=$2`, [req.params.bookingId, req.actor.agencyId]);
    if (!rows.length) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
    return res.json({ apiVersion: 'v2', ...rows[0] });
  });

  app.post('/v2/admin/projections/rebuild', requireAuth, requireScope('admin'), async (req, res) => {
    const { rows } = await pool.query('SELECT rebuild_booking_read_model() AS rebuilt');
    await audit('cqrs.projection_rebuilt', { rebuilt: rows[0].rebuilt, agencyId: req.actor.agencyId });
    return res.json({ status: 'COMPLETED', recordsRebuilt: rows[0].rebuilt, source: 'booking_events' });
  });

  app.get('/v2/bookings/:bookingId/events', requireAuth, requireScope('bookings:read'), async (req, res) => {
    const owner = await pool.query('SELECT 1 FROM bookings WHERE booking_id=$1 AND agency_id=$2', [req.params.bookingId, req.actor.agencyId]);
    if (!owner.rowCount) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
    const { rows } = await pool.query(`SELECT event_version AS version,event_type AS type,payload,occurred_at AS "occurredAt"
      FROM booking_events WHERE booking_id=$1 ORDER BY event_version`, [req.params.bookingId]);
    return res.json({ bookingId: req.params.bookingId, eventCount: rows.length, events: rows });
  });

  app.get('/v1/pnrs/:pnr', requireAuth, requireScope('bookings:read'), async (req, res) => {
    const { rows } = await pool.query(`SELECT p.pnr_code AS "pnr",p.status AS "pnrStatus",p.created_at AS "createdAt",
      r.booking_id AS "bookingId",r.flight_id AS "flightId",r.seat_number AS "seatNumber",r.status AS "bookingStatus",
      r.amount,r.currency,t.ticket_number AS "ticketNumber",t.status AS "ticketStatus"
      FROM pnr_records p JOIN booking_read_model r USING(booking_id) LEFT JOIN tickets t USING(booking_id)
      WHERE p.pnr_code=$1 AND p.agency_id=$2`, [String(req.params.pnr).toUpperCase(), req.actor.agencyId]);
    pnrLookups.inc({ result: rows.length ? 'found' : 'not_found' });
    if (!rows.length) return res.status(404).json({ error: 'PNR_NOT_FOUND' });
    return res.json(rows[0]);
  });

  app.post('/v1/bookings/:bookingId/passengers', requireAuth, requireScope('bookings:write'), async (req, res) => {
    const { firstName, lastName, documentReference, passengerType = 'ADT' } = req.body || {};
    if (!firstName || !lastName || !['ADT', 'CHD', 'INF'].includes(passengerType))
      return res.status(400).json({ error: 'PASSENGER_DATA_INVALID' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const booking = await client.query('SELECT booking_id FROM bookings WHERE booking_id=$1 AND agency_id=$2 FOR UPDATE', [req.params.bookingId, req.actor.agencyId]);
      if (!booking.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'BOOKING_NOT_FOUND' }); }
      const hash = documentReference ? crypto.createHash('sha256').update(String(documentReference)).digest('hex') : null;
      const inserted = await client.query(`INSERT INTO booking_passengers(booking_id,first_name,last_name,document_reference_hash,passenger_type)
        VALUES($1,$2,$3,$4,$5) RETURNING passenger_id AS "passengerId",first_name AS "firstName",last_name AS "lastName",passenger_type AS "passengerType"`,
      [req.params.bookingId, String(firstName).trim(), String(lastName).trim(), hash, passengerType]);
      const version = await client.query('SELECT COALESCE(MAX(event_version),0)+1 AS v FROM booking_events WHERE booking_id=$1', [req.params.bookingId]);
      await client.query(`INSERT INTO booking_events(booking_id,event_version,event_type,payload) VALUES($1,$2,'booking.passenger_added',$3)`,
        [req.params.bookingId, version.rows[0].v, JSON.stringify({ passengerId: inserted.rows[0].passengerId, passengerType })]);
      await client.query('COMMIT');
      eventsAppended.inc({ event_type: 'booking.passenger_added' });
      await audit('booking.passenger_added', { bookingId: req.params.bookingId, passengerId: inserted.rows[0].passengerId, agencyId: req.actor.agencyId });
      return res.status(201).json(inserted.rows[0]);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  });

  app.get('/v1/bookings/:bookingId/passengers', requireAuth, requireScope('bookings:read'), async (req, res) => {
    const owner = await pool.query('SELECT 1 FROM bookings WHERE booking_id=$1 AND agency_id=$2', [req.params.bookingId, req.actor.agencyId]);
    if (!owner.rowCount) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
    const { rows } = await pool.query(`SELECT passenger_id AS "passengerId",first_name AS "firstName",last_name AS "lastName",passenger_type AS "passengerType"
      FROM booking_passengers WHERE booking_id=$1 ORDER BY created_at`, [req.params.bookingId]);
    return res.json({ passengers: rows });
  });

  app.post('/v1/bookings/:bookingId/tickets/issue', requireAuth, requireScope('bookings:write'), async (req, res) => {
    const { rows } = await pool.query(`SELECT b.status,p.pnr_code FROM bookings b JOIN pnr_records p USING(booking_id)
      WHERE b.booking_id=$1 AND b.agency_id=$2`, [req.params.bookingId, req.actor.agencyId]);
    if (!rows.length) return res.status(404).json({ error: 'BOOKING_NOT_FOUND' });
    if (!canIssueTicket(rows[0].status)) return res.status(409).json({ error: 'BOOKING_NOT_CONFIRMED' });
    const result = await pool.query(`INSERT INTO tickets(ticket_number,booking_id,pnr_code) VALUES($1,$2,$3)
      ON CONFLICT(booking_id) DO UPDATE SET ticket_number=tickets.ticket_number RETURNING ticket_number AS "ticketNumber",booking_id AS "bookingId",pnr_code AS "pnr",status,issued_at AS "issuedAt"`,
    [ticketNumber(req.params.bookingId), req.params.bookingId, rows[0].pnr_code]);
    ticketOperations.inc({ operation: 'issue', result: 'success' });
    await audit('ticket.issued', { bookingId: req.params.bookingId, ticketNumber: result.rows[0].ticketNumber, agencyId: req.actor.agencyId });
    return res.status(200).json({ ...result.rows[0], replaySafe: true });
  });

  app.post('/v1/tickets/:ticketNumber/void', requireAuth, requireScope('bookings:write'), async (req, res) => {
    const client = await pool.connect();
    let ticket;
    try {
      await client.query('BEGIN');
      const updated = await client.query(`UPDATE tickets t SET status='VOID',voided_at=now()
        FROM bookings b WHERE t.booking_id=b.booking_id AND t.ticket_number=$1 AND b.agency_id=$2 AND t.status='ISSUED'
        RETURNING t.ticket_number AS "ticketNumber",t.booking_id AS "bookingId",t.status,t.voided_at AS "voidedAt"`,
      [req.params.ticketNumber, req.actor.agencyId]);
      if (!updated.rowCount) {
        const exists = await client.query(`SELECT t.status FROM tickets t JOIN bookings b USING(booking_id) WHERE t.ticket_number=$1 AND b.agency_id=$2`, [req.params.ticketNumber, req.actor.agencyId]);
        await client.query('ROLLBACK');
        if (!exists.rowCount) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
        if (exists.rows[0].status === 'VOID') return res.json({ ticketNumber: req.params.ticketNumber, status: 'VOID', replaySafe: true });
        return res.status(409).json({ error: 'TICKET_NOT_VOIDABLE' });
      }
      ticket = updated.rows[0];
      const version = await client.query('SELECT COALESCE(MAX(event_version),0)+1 AS v FROM booking_events WHERE booking_id=$1', [ticket.bookingId]);
      await client.query(`INSERT INTO booking_events(booking_id,event_version,event_type,payload) VALUES($1,$2,'ticket.voided',$3)`,
        [ticket.bookingId, version.rows[0].v, JSON.stringify({ ticketNumber: ticket.ticketNumber, reason: req.body?.reason || 'AGENCY_REQUEST' })]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    eventsAppended.inc({ event_type: 'ticket.voided' });
    ticketOperations.inc({ operation: 'void', result: 'success' });
    await audit('ticket.voided', { ticketNumber: ticket.ticketNumber, bookingId: ticket.bookingId, agencyId: req.actor.agencyId });
    return res.json(ticket);
  });
  return { eventsAppended, ticketOperations, pnrLookups };
}

module.exports = { registerEnterpriseRoutes };
