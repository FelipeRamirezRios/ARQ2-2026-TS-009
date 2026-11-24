const express = require('express');
const { registerEnterpriseRoutes } = require('./enterprise');
const { hashBookingRequest, idempotencyReplay } = require('../../packages/enterprise');
const axios = require('axios');
const { pool, redis, rabbit, publish, retryOrDeadLetter, audit, requireAuth, requireScope, logger, metricsMiddleware, metricsText, seatLockAttempts, sagaBookings, randomUUID } = require('../../packages/common');
const { classifyBooking } = require('../../packages/reconciliation');
const prom = require('prom-client');
const reconciliationFindings = new prom.Counter({ name:'aerobooking_reconciliation_findings_total', help:'Detected booking/ledger inconsistencies', labelNames:['code','severity'] });
const outboxFailures = new prom.Counter({ name:'aerobooking_outbox_publish_failures_total', help:'Outbox publication failures' });
const outboxBacklog = new prom.Gauge({ name:'aerobooking_outbox_unpublished', help:'Number of outbox messages awaiting publication' });
const app=express(); app.use(express.json()); app.use(logger('booking-service')); app.use(metricsMiddleware('booking-service'));
app.get('/metrics',async(_req,res)=>res.type('text/plain').send((await metricsText())+'\n'+(await prom.register.metrics())));
let enterpriseMetrics;
const lockTtl=Number(process.env.SEAT_LOCK_TTL_MS||120000);
const releaseLua="if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
app.get('/health',(_req,res)=>res.json({status:'ok',service:'booking-service'}));
// Administrative reconciliation is intentionally report-first: it never invents refunds/captures.
app.post('/v1/admin/reconciliation/run',requireAuth,requireScope('admin'),async(req,res)=>{
  const runId=randomUUID(), correlationId=req.correlationId||randomUUID();
  try {
    const c=await pool.connect(); let findings=[], scannedBookings=0;
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO reconciliation_runs(run_id,status,initiated_by,correlation_id) VALUES($1,'RUNNING',$2,$3)",[runId,req.actor.agencyId,correlationId]);
      const {rows}=await c.query(`SELECT b.booking_id,b.status AS booking_status,s.saga_id,s.state AS saga_state,
        EXISTS(SELECT 1 FROM agency_ledger l WHERE l.booking_id=b.booking_id AND l.entry_type='HOLD') AS hold_exists,
        EXISTS(SELECT 1 FROM agency_ledger l WHERE l.booking_id=b.booking_id AND l.entry_type='REFUND') AS refund_exists,
        EXISTS(SELECT 1 FROM agency_ledger l WHERE l.booking_id=b.booking_id AND l.entry_type='CAPTURE') AS capture_exists,
        (s.saga_id IS NOT NULL) AS saga_exists
        FROM bookings b LEFT JOIN purchase_saga s ON s.booking_id=b.booking_id
        WHERE b.created_at > now()-interval '90 days' ORDER BY b.created_at DESC LIMIT 5000`);
      scannedBookings=rows.length;
      for(const row of rows) for(const finding of classifyBooking(row)) findings.push({bookingId:row.booking_id,...finding});
      for(const f of findings) reconciliationFindings.inc({code:f.code,severity:f.severity});
      await c.query("UPDATE reconciliation_runs SET status='COMPLETED',finished_at=now(),findings=$2 WHERE run_id=$1",[runId,JSON.stringify(findings)]);
      await c.query('COMMIT');
    } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();}
    await audit('reconciliation.completed',{correlationId,runId,findings:findings.length});
    return res.json({runId,correlationId,scannedBookings,findingCount:findings.length,findings,mode:'REPORT_ONLY'});
  } catch(err){console.error(JSON.stringify({level:'error',service:'reconciliation',runId,error:err.message}));return res.status(500).json({error:'RECONCILIATION_FAILED',runId});}
});
app.get('/v1/admin/reconciliation/runs',requireAuth,requireScope('admin'),async(_req,res)=>{
  const {rows}=await pool.query('SELECT run_id AS "runId",started_at AS "startedAt",finished_at AS "finishedAt",status,findings FROM reconciliation_runs ORDER BY started_at DESC LIMIT 50');
  return res.json(rows);
});
app.post('/v1/bookings/lock',requireAuth,requireScope('bookings:write'),async(req,res)=>{
  const {flightId,seatNumber}=req.body||{}; if(!flightId||!seatNumber)return res.status(400).json({error:'FLIGHT_AND_SEAT_REQUIRED'});
  const key=`seatlock:${flightId}:${seatNumber}`, token=randomUUID();
  try{
    await pool.query("UPDATE seat_locks SET status='EXPIRED' WHERE flight_id=$1 AND seat_number=$2 AND status='ACTIVE' AND expires_at<=now()",[flightId,seatNumber]);
    const sold=await pool.query("SELECT 1 FROM seat_locks WHERE flight_id=$1 AND seat_number=$2 AND status='SOLD' LIMIT 1",[flightId,seatNumber]);
    if(sold.rows.length){seatLockAttempts.inc({result:'already_sold'});return res.status(409).json({error:'SEAT_ALREADY_SOLD'});}
    const acquired=await redis.set(key,token,'PX',lockTtl,'NX');
    if(!acquired){seatLockAttempts.inc({result:'contended'});return res.status(409).json({error:'SEAT_ALREADY_LOCKED'});}
    const fencingToken=await redis.incr(`fence:${flightId}:${seatNumber}`);
    const expiresAt=new Date(Date.now()+lockTtl).toISOString();
    const lockId=randomUUID();
    await pool.query(`INSERT INTO seat_locks(lock_id,flight_id,seat_number,agency_id,lock_token,fencing_token,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',$7)`,[lockId,flightId,seatNumber,req.actor.agencyId,token,fencingToken,expiresAt]);
    seatLockAttempts.inc({result:'acquired'});
    await audit('inventory.seat_locked',{correlationId:req.correlationId,agencyId:req.actor.agencyId,flightId,seatNumber,fencingToken});
    return res.json({lockToken:token,fencingToken,expiresAt});
  }catch(err){await redis.eval(releaseLua,1,key,token).catch(()=>{});console.error(err);return res.status(503).json({error:'LOCK_STORE_UNAVAILABLE'});}
});
app.post('/v1/bookings',requireAuth,requireScope('bookings:write'),async(req,res)=>{
  const idempotencyKey=req.headers['idempotency-key'];
  const {flightId,seatNumber,lockToken,fareQuoteId,paymentMethodId}=req.body||{};
  if(!idempotencyKey)return res.status(400).json({error:'IDEMPOTENCY_KEY_REQUIRED'});
  if(!flightId||!seatNumber||!lockToken||!fareQuoteId||!paymentMethodId)
    return res.status(400).json({error:'FLIGHT_SEAT_LOCK_FARE_AND_PAYMENT_REQUIRED'});
  const client=await pool.connect();
  const requestHash=hashBookingRequest({flightId,seatNumber,fareQuoteId,paymentMethodId});
  try{
    await client.query('BEGIN');
    const existing=await client.query('SELECT b.booking_id,b.correlation_id,b.status,s.idempotency_hash FROM bookings b JOIN purchase_saga s ON s.booking_id=b.booking_id WHERE s.idempotency_key=$1 AND s.agency_id=$2',[idempotencyKey,req.actor.agencyId]);
    if(existing.rows.length){await client.query('ROLLBACK');const replay=idempotencyReplay(existing.rows[0].idempotency_hash,requestHash);if(!replay.allowed)return res.status(replay.status).json({error:replay.error});return res.status(200).json({bookingId:existing.rows[0].booking_id,correlationId:existing.rows[0].correlation_id,status:existing.rows[0].status,replayed:true});}
    const lock=await client.query(`SELECT * FROM seat_locks WHERE lock_token=$1 AND agency_id=$2 AND status='ACTIVE' AND expires_at>now() FOR UPDATE`,[lockToken,req.actor.agencyId]);
    if(!lock.rows.length){await client.query('ROLLBACK');return res.status(409).json({error:'LOCK_TOKEN_EXPIRED_OR_INVALID'});}
    if(lock.rows[0].flight_id!==flightId || lock.rows[0].seat_number!==seatNumber){
      await client.query('ROLLBACK');return res.status(409).json({error:'LOCK_FLIGHT_OR_SEAT_MISMATCH'});
    }
    const quote=await client.query('SELECT * FROM fare_quotes WHERE quote_id=$1 AND expires_at>now()',[fareQuoteId]);
    if(!quote.rows.length){await client.query('ROLLBACK');return res.status(409).json({error:'FARE_QUOTE_EXPIRED'});}
    if(quote.rows[0].flight_id!==lock.rows[0].flight_id){await client.query('ROLLBACK');return res.status(409).json({error:'FARE_QUOTE_FLIGHT_MISMATCH'});}
    const l=lock.rows[0],q=quote.rows[0], bookingId=randomUUID(),sagaId=randomUUID(),correlationId=req.correlationId||randomUUID();
    await client.query(`INSERT INTO bookings(booking_id,correlation_id,saga_id,agency_id,flight_id,seat_number,fare_quote_id,status,amount,currency) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9)`,[bookingId,correlationId,sagaId,req.actor.agencyId,l.flight_id,l.seat_number,fareQuoteId,q.price,q.currency]);
    await client.query(`INSERT INTO purchase_saga(saga_id,booking_id,agency_id,state,step,fencing_token,correlation_id,lock_token,idempotency_key,idempotency_hash) VALUES($1,$2,$3,'STARTED',0,$4,$5,$6,$7,$8)`,[sagaId,bookingId,req.actor.agencyId,l.fencing_token,correlationId,lockToken,idempotencyKey,requestHash]);
    await client.query(`INSERT INTO outbox(routing_key,payload) VALUES('booking.start',$1)`,[JSON.stringify({service:'booking-service',bookingId,sagaId,agencyId:req.actor.agencyId,correlationId,flightId,seatNumber,fencingToken:l.fencing_token,lockToken,fareQuoteId,amount:q.price,currency:q.currency,airline:q.airline,paymentMethodId,idempotencyKey})]);
    await client.query('COMMIT');
    enterpriseMetrics?.eventsAppended.inc({event_type:'booking.created'});
    return res.status(202).json({bookingId,correlationId,status:'PENDING'});
  }catch(err){await client.query('ROLLBACK').catch(()=>{});if(err.code==='23505'){const raced=await pool.query('SELECT b.booking_id,b.correlation_id,b.status,s.idempotency_hash FROM bookings b JOIN purchase_saga s ON s.booking_id=b.booking_id WHERE s.idempotency_key=$1 AND s.agency_id=$2',[idempotencyKey,req.actor.agencyId]).catch(()=>({rows:[]}));if(raced.rows.length){const replay=idempotencyReplay(raced.rows[0].idempotency_hash,requestHash);if(!replay.allowed)return res.status(409).json({error:replay.error});return res.status(200).json({bookingId:raced.rows[0].booking_id,correlationId:raced.rows[0].correlation_id,status:raced.rows[0].status,replayed:true});}}console.error(JSON.stringify({level:'error',service:'booking-service',error:err.message}));return res.status(500).json({error:'BOOKING_CREATION_FAILED'});}finally{client.release();}
});
app.get('/v1/bookings/:bookingId',requireAuth,requireScope('bookings:read'),async(req,res)=>{
  const {rows}=await pool.query('SELECT booking_id AS "bookingId",status,updated_at AS "updatedAt",airline_reason AS reason FROM bookings WHERE booking_id=$1 AND agency_id=$2',[req.params.bookingId,req.actor.agencyId]);
  if(!rows.length)return res.status(404).json({error:'BOOKING_NOT_FOUND'}); return res.json(rows[0]);
});
async function addOutbox(routingKey,payload){await pool.query('INSERT INTO outbox(routing_key,payload) VALUES($1,$2)',[routingKey,JSON.stringify(payload)]);}
async function reserveFunds(s){
  const current=await pool.query('SELECT state FROM purchase_saga WHERE saga_id=$1',[s.saga_id]);
  if(!current.rows.length||!['STARTED','SEAT_LOCKED'].includes(current.rows[0].state))return;
  if(current.rows[0].state==='STARTED')await pool.query("UPDATE purchase_saga SET state='SEAT_LOCKED',step=1,updated_at=now() WHERE saga_id=$1 AND state='STARTED'",[s.saga_id]);
  const revalidated=await axios.post(`${process.env.AIRLINE_CONNECTOR_URL||'http://localhost:3004'}/internal/fares/revalidate`,{airline:s.airline,quoteId:s.fare_quote_id,flightId:s.flight_id},{timeout:5000});
  if(!revalidated.data.valid) throw new Error('PRICE_CHANGED');
  const c=await pool.connect();try{await c.query('BEGIN');
    const state=await c.query('SELECT state FROM purchase_saga WHERE saga_id=$1 FOR UPDATE',[s.saga_id]);
    if(!state.rows.length||!['STARTED','SEAT_LOCKED'].includes(state.rows[0].state)){await c.query('ROLLBACK');return;}
    const exists=await c.query("SELECT 1 FROM agency_ledger WHERE idempotency_ref=$1",[`hold:${s.booking_id}`]);
    if(!exists.rows.length){const agency=await c.query('SELECT balance FROM agencies WHERE id=$1 FOR UPDATE',[s.agency_id]);if(!agency.rows.length||Number(agency.rows[0].balance)<Number(s.amount))throw new Error('INSUFFICIENT_AGENCY_BALANCE');
      await c.query('UPDATE agencies SET balance=balance-$1 WHERE id=$2',[s.amount,s.agency_id]);
      await c.query(`INSERT INTO agency_ledger(agency_id,booking_id,entry_type,amount,idempotency_ref) VALUES($1,$2,'HOLD',$3,$4)`,[s.agency_id,s.booking_id,s.amount,`hold:${s.booking_id}`]);}
    await c.query("UPDATE purchase_saga SET state='FUNDS_RESERVED',step=3,updated_at=now() WHERE saga_id=$1",[s.saga_id]);
    const commandId=randomUUID();
    await c.query("INSERT INTO outbox(routing_key,payload) VALUES('command.airline.book',$1)",[JSON.stringify({
      service:'booking-service',eventType:'cmd.airline.book',commandId,sagaId:s.saga_id,
      bookingId:s.booking_id,correlationId:s.correlation_id,agencyId:s.agency_id,
      flightId:s.flight_id,seatNumber:s.seat_number,fencingToken:Number(s.fencing_token),
      idempotencyKey:s.idempotency_key,lockToken:s.lock_token,amount:s.amount,
      currency:s.currency,airline:s.airline,timestamp:new Date().toISOString()
    })]);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

async function completeBooking(event){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const locked=await c.query('SELECT state FROM purchase_saga WHERE saga_id=$1 FOR UPDATE',[event.sagaId]);
    if(!locked.rows.length||['COMPENSATING','COMPENSATED'].includes(locked.rows[0].state)){await c.query('ROLLBACK');return;}
    await c.query("UPDATE bookings SET status='CONFIRMED',airline_confirmation_code=$2,updated_at=now() WHERE booking_id=$1",[event.bookingId,event.airlineConfirmationCode]);
    await c.query("UPDATE purchase_saga SET state='AIRLINE_CONFIRMED',step=4,updated_at=now() WHERE saga_id=$1",[event.sagaId]);
    await c.query("UPDATE seat_locks SET status='SOLD' WHERE lock_token=(SELECT lock_token FROM purchase_saga WHERE saga_id=$1)",[event.sagaId]);
    await c.query("INSERT INTO agency_ledger(agency_id,booking_id,entry_type,amount,idempotency_ref) SELECT agency_id,booking_id,'CAPTURE',amount,$2 FROM bookings WHERE booking_id=$1 ON CONFLICT DO NOTHING",[event.bookingId,`capture:${event.bookingId}`]);
    await c.query("UPDATE purchase_saga SET state='COMPLETED',step=5,updated_at=now() WHERE saga_id=$1",[event.sagaId]);
    await c.query('COMMIT');
    enterpriseMetrics?.eventsAppended.inc({event_type:'booking.status_changed'});
    enterpriseMetrics?.ticketOperations.inc({operation:'issue',result:'success'});
    enterpriseMetrics?.eventsAppended.inc({event_type:'ticket.issued'});
    sagaBookings.inc({outcome:'confirmed'});
  }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}
async function compensate(event){
  const c=await pool.connect();let ticketWasIssued=false;try{await c.query('BEGIN');
    const saga=await c.query('SELECT * FROM purchase_saga WHERE saga_id=$1 FOR UPDATE',[event.sagaId]);if(!saga.rows.length){await c.query('ROLLBACK');return;}
    const s=saga.rows[0];if(['COMPENSATED','COMPLETED'].includes(s.state)){await c.query('ROLLBACK');return;}
    await c.query("UPDATE purchase_saga SET state='COMPENSATING',updated_at=now() WHERE saga_id=$1",[s.saga_id]);
    const hold=await c.query("SELECT 1 FROM agency_ledger WHERE booking_id=$1 AND entry_type='HOLD'",[s.booking_id]);
    if(hold.rows.length){const refund=await c.query("SELECT 1 FROM agency_ledger WHERE idempotency_ref=$1",[`refund:${s.booking_id}`]);if(!refund.rows.length){const b=await c.query('SELECT amount,agency_id FROM bookings WHERE booking_id=$1',[s.booking_id]);await c.query('UPDATE agencies SET balance=balance+$1 WHERE id=$2',[b.rows[0].amount,b.rows[0].agency_id]);await c.query(`INSERT INTO agency_ledger(agency_id,booking_id,entry_type,amount,idempotency_ref) VALUES($1,$2,'REFUND',$3,$4)`,[b.rows[0].agency_id,s.booking_id,b.rows[0].amount,`refund:${s.booking_id}`]);}}
    await redis.eval(releaseLua,1,`seatlock:${event.flightId||''}:${event.seatNumber||''}`,s.lock_token).catch(()=>0);
    await c.query("UPDATE seat_locks SET status='RELEASED' WHERE lock_token=$1",[s.lock_token]);
    const issuedTicket=await c.query("SELECT 1 FROM tickets WHERE booking_id=$1 AND status='ISSUED'",[s.booking_id]);ticketWasIssued=issuedTicket.rowCount>0;
    await c.query("UPDATE bookings SET status='COMPENSATED',airline_reason=$2,updated_at=now() WHERE booking_id=$1",[s.booking_id,event.reason||'AIRLINE_REJECTED']);
    await c.query("UPDATE purchase_saga SET state='COMPENSATED',step=6,updated_at=now() WHERE saga_id=$1",[s.saga_id]);
    await c.query("INSERT INTO outbox(routing_key,payload) VALUES('booking.compensated',$1)",[JSON.stringify({service:'booking-service',bookingId:s.booking_id,sagaId:s.saga_id,correlationId:s.correlation_id,refundId:`refund:${s.booking_id}`,seatReleased:true,reason:event.reason||'AIRLINE_REJECTED'})]);
    await c.query('COMMIT');
    enterpriseMetrics?.eventsAppended.inc({event_type:'booking.status_changed'});
    if(ticketWasIssued){enterpriseMetrics?.ticketOperations.inc({operation:'void',result:'success'});enterpriseMetrics?.eventsAppended.inc({event_type:'ticket.voided'});}
    sagaBookings.inc({outcome:'compensated'});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function consumeSaga(){
 const ch=await rabbit();await ch.assertQueue('booking.orchestrator',{durable:true,arguments:{'x-dead-letter-exchange':'aerobooking.dlx'}});
 for(const key of ['booking.start','booking.confirmed','booking.rejected','booking.unknown'])await ch.bindQueue('booking.orchestrator','aerobooking.events',key);
 ch.prefetch(10);
 ch.consume('booking.orchestrator',async msg=>{if(!msg)return;const e=JSON.parse(msg.content.toString());try{
  const seen=await pool.query('SELECT 1 FROM inbox WHERE message_id=$1',[`booking:${e.message_id}`]);if(seen.rows.length){ch.ack(msg);return;}
  if(msg.fields.routingKey==='booking.start'){
    const {rows}=await pool.query(`SELECT s.*,b.flight_id,b.seat_number,b.fare_quote_id,b.amount,b.currency,q.airline FROM purchase_saga s JOIN bookings b USING(booking_id) JOIN fare_quotes q ON q.quote_id=b.fare_quote_id WHERE s.saga_id=$1`,[e.sagaId]);
    if(rows.length){try{await reserveFunds({...rows[0],booking_id:rows[0].booking_id});}catch(err){if(['INSUFFICIENT_AGENCY_BALANCE','PRICE_CHANGED'].includes(err.message)){await compensate({bookingId:rows[0].booking_id,sagaId:rows[0].saga_id,flightId:rows[0].flight_id,seatNumber:rows[0].seat_number,reason:err.message});}else throw err;}}
  } else if(msg.fields.routingKey==='booking.confirmed'){
    await completeBooking(e);
  } else if(msg.fields.routingKey==='booking.unknown'){
    await pool.query("UPDATE purchase_saga SET updated_at=now() WHERE saga_id=$1",[e.sagaId]);
    await audit('saga.airline_unknown',e);
  } else if(msg.fields.routingKey==='booking.rejected'){
    const {rows}=await pool.query('SELECT b.flight_id,b.seat_number FROM bookings b WHERE b.booking_id=$1',[e.bookingId]);
    const booking=rows[0]||{};
    await compensate({...e,flightId:booking.flight_id,seatNumber:booking.seat_number});
  }
  await pool.query('INSERT INTO inbox(message_id) VALUES($1) ON CONFLICT DO NOTHING',[`booking:${e.message_id}`]);
  ch.ack(msg);
 }catch(err){console.error(JSON.stringify({level:'error',service:'booking-orchestrator',error:err.message,bookingId:e.bookingId}));await retryOrDeadLetter(ch,msg,'booking.orchestrator').catch(()=>ch.nack(msg,false,true));}} ,{noAck:false});
 ch.once('close',()=>setTimeout(()=>consumeSaga().catch(err=>console.error(err)),5000));
}
async function relayOutbox(){
 setInterval(async()=>{const c=await pool.connect();try{
  await c.query('BEGIN');
  const {rows}=await c.query("SELECT * FROM outbox WHERE published_at IS NULL AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 50");
  for(const row of rows){
   try{await publish(row.routing_key,{...row.payload,message_id:row.message_id});await c.query('UPDATE outbox SET published_at=now(),locked_at=NULL,last_error=NULL WHERE id=$1',[row.id]);}
   catch(err){outboxFailures.inc();const attempts=Number(row.attempts||0)+1;const delay=Math.min(300,2**Math.min(attempts,8));await c.query(`UPDATE outbox SET attempts=$2,last_error=$3,available_at=now()+($4 * interval '1 second'),locked_at=NULL WHERE id=$1`,[row.id,attempts,String(err.message).slice(0,1000),delay]);}
  }
  await c.query('COMMIT');
  const pending=await pool.query('SELECT count(*)::int AS count FROM outbox WHERE published_at IS NULL');outboxBacklog.set(pending.rows[0].count);
 }catch(e){await c.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({level:'error',service:'outbox-relay',error:e.message}));}finally{c.release();}},500);
}
async function recover(){setInterval(async()=>{try{
  const {rows:started}=await pool.query("SELECT s.*,b.flight_id,b.seat_number,b.fare_quote_id,b.amount,b.currency,q.airline FROM purchase_saga s JOIN bookings b USING(booking_id) JOIN fare_quotes q ON q.quote_id=b.fare_quote_id WHERE s.state IN ('STARTED','SEAT_LOCKED') AND s.updated_at < now()-interval '30 seconds'");
  for(const s of started){try{await reserveFunds(s);}catch(err){if(['INSUFFICIENT_AGENCY_BALANCE','PRICE_CHANGED'].includes(err.message))await compensate({bookingId:s.booking_id,sagaId:s.saga_id,flightId:s.flight_id,seatNumber:s.seat_number,reason:err.message});else throw err;}}
  const {rows}=await pool.query("SELECT s.saga_id,s.booking_id,s.correlation_id,s.attempts,b.flight_id,b.seat_number FROM purchase_saga s JOIN bookings b USING(booking_id) WHERE s.state='FUNDS_RESERVED' AND s.updated_at < now()-interval '30 seconds'");
  for(const s of rows){const {data}=await axios.get(`${process.env.AIRLINE_CONNECTOR_URL||'http://localhost:3004'}/internal/bookings/${s.booking_id}/status`,{timeout:4000});if(data.ok===true){await publish('booking.confirmed',{service:'booking-service',bookingId:s.booking_id,sagaId:s.saga_id,correlationId:s.correlation_id,airlineConfirmationCode:data.confirmationCode,rawResponse:data.raw,reconciled:true});}else if(data.reason && data.reason!=='AIRLINE_UNKNOWN'){await publish('booking.rejected',{service:'booking-service',bookingId:s.booking_id,sagaId:s.saga_id,correlationId:s.correlation_id,reason:data.reason,airlineErrorCode:data.airlineErrorCode,flightId:s.flight_id,seatNumber:s.seat_number,reconciled:true});}else{await pool.query("UPDATE purchase_saga SET attempts=attempts+1,updated_at=now() WHERE saga_id=$1",[s.saga_id]);await audit('saga.recovery_check',{...s,outcome:'UNKNOWN',attempt:s.attempts+1});if(s.attempts+1>=3)await audit('saga.manual_reconciliation_required',{...s,reason:'AIRLINE_OUTCOME_STILL_UNKNOWN'});}}
 }catch(e){console.error(JSON.stringify({level:'error',service:'saga-recovery',error:e.message}));}},30000);}
enterpriseMetrics=registerEnterpriseRoutes(app,{pool,requireAuth,requireScope,audit});
app.listen(Number(process.env.PORT||3003),'0.0.0.0',()=>console.log('booking-service listening'));
Promise.all([consumeSaga(),new Promise(resolve=>{relayOutbox();recover();resolve();})]).catch(e=>{console.error(e);process.exit(1)});
