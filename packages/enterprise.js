const crypto = require('node:crypto');
function hashBookingRequest({ flightId, seatNumber, fareQuoteId, paymentMethodId }) {
  return crypto.createHash('sha256').update(JSON.stringify({ flightId, seatNumber, fareQuoteId, paymentMethodId })).digest('hex');
}
function idempotencyReplay(existingHash, requestHash) {
  if (existingHash && existingHash !== requestHash) return { allowed: false, status: 409, error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' };
  return { allowed: true, status: 200, replayed: true };
}
function canIssueTicket(bookingStatus) { return bookingStatus === 'CONFIRMED'; }
function ticketNumber(bookingId) { return `ETK-${String(bookingId).replaceAll('-', '').slice(0, 13).toUpperCase()}`; }
module.exports = { hashBookingRequest, idempotencyReplay, canIssueTicket, ticketNumber };
