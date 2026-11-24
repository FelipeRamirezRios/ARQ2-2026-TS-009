'use strict';

/** Classify persisted purchase state without performing unsafe financial mutations. */
function classifyBooking(row) {
  const findings = [];
  if (row.booking_status === 'CONFIRMED' && !row.capture_exists)
    findings.push({ code: 'CONFIRMED_WITHOUT_CAPTURE', severity: 'critical', action: 'REVIEW_LEDGER' });
  if (row.booking_status === 'COMPENSATED' && row.hold_exists && !row.refund_exists)
    findings.push({ code: 'COMPENSATED_WITHOUT_REFUND', severity: 'critical', action: 'RETRY_COMPENSATION' });
  if (row.booking_status === 'PENDING' && !row.saga_exists)
    findings.push({ code: 'PENDING_WITHOUT_SAGA', severity: 'high', action: 'MANUAL_REVIEW' });
  if (row.saga_state === 'COMPLETED' && row.booking_status !== 'CONFIRMED')
    findings.push({ code: 'SAGA_BOOKING_STATUS_MISMATCH', severity: 'high', action: 'MANUAL_REVIEW' });
  if (row.saga_state === 'COMPENSATED' && row.booking_status !== 'COMPENSATED')
    findings.push({ code: 'SAGA_COMPENSATION_STATUS_MISMATCH', severity: 'high', action: 'MANUAL_REVIEW' });
  return findings;
}
module.exports = { classifyBooking };
