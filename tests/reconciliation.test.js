const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyBooking } = require('../packages/reconciliation');
test('confirmed booking without capture is reported as critical',()=>{
 const f=classifyBooking({booking_status:'CONFIRMED',capture_exists:false});
 assert.deepEqual(f.map(x=>x.code),['CONFIRMED_WITHOUT_CAPTURE']);
 assert.equal(f[0].severity,'critical');
});
test('compensated booking with unreversed hold is reported',()=>{
 const f=classifyBooking({booking_status:'COMPENSATED',hold_exists:true,refund_exists:false});
 assert.equal(f[0].code,'COMPENSATED_WITHOUT_REFUND');
});
test('consistent completed purchase has no findings',()=>{
 assert.deepEqual(classifyBooking({booking_status:'CONFIRMED',capture_exists:true,saga_state:'COMPLETED'}),[]);
});
test('Saga and booking status disagreement is reported',()=>{
 const f=classifyBooking({booking_status:'PENDING',saga_state:'COMPLETED',capture_exists:false});
 assert.ok(f.some(x=>x.code==='SAGA_BOOKING_STATUS_MISMATCH'));
});
