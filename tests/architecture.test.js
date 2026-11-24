const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('Wave 1 source artifacts are preserved',()=>{
 for(const f of ['docs/spec.md','docs/adrs/001-api-gateway-kong.md','docs/adrs/007-B2B-Auth.md','docs/assets/aerobooking-c4-level2.drawio.png'])assert.ok(fs.existsSync(path.join(root,f)),`${f} must exist`);
});
test('Wave 2 contains the mandatory infrastructure stack',()=>{
 const compose=read('docker-compose.yml');
 for(const s of ['kong','postgres','valkey','rabbitmq','prometheus','loki','grafana'])assert.match(compose,new RegExp(`^  ${s}:`,'m'));
});
test('Feature 1: OAuth2, RS256 and token revocation are implemented',()=>{
 const auth=read('services/auth/index.js'),gateway=read('gateway/kong/plugins/jwt-revocation/handler.lua');
 assert.match(auth,/client_credentials/);assert.match(auth,/RS256/);assert.match(auth,/revoked:/);assert.match(gateway,/revoked:/);
});
test('Feature 2: cache-aside, single-flight and airline token bucket are implemented',()=>{
 assert.match(read('services/search/index.js'),/lock:fare:/);assert.match(read('services/search/index.js'),/FARE_TTL_SECONDS/);assert.match(read('services/airline-connector/index.js'),/bucketLua/);
});
test('Feature 3: atomic seat locks and fencing tokens are implemented',()=>{
 const booking=read('services/booking/index.js'),airline=read('services/airline-connector/index.js');
 assert.match(booking,/PX',lockTtl,'NX/);assert.match(booking,/fence:/);assert.match(airline,/currentFence!==Number\(command\.fencingToken\)/);
});
test('Feature 4: Saga compensation, outbox and recovery are implemented',()=>{
 const booking=read('services/booking/index.js'),sql=read('infrastructure/postgres/init.sql');
 assert.match(booking,/async function compensate/);assert.match(booking,/RefundFunds|REFUND/);assert.match(booking,/async function recover/);assert.match(sql,/CREATE TABLE IF NOT EXISTS outbox/);
});
test('Feature 5: append-only audit and hash chain are implemented',()=>{
 const sql=read('infrastructure/postgres/init.sql'),audit=read('services/audit/index.js');
 assert.match(sql,/block_audit_mutation/);assert.match(sql,/compute_hash_chain/);assert.match(sql,/digest\(/);assert.match(audit,/globalChainLinked/);
});
test('OpenSpec remains the contract source of truth',()=>{
 const spec=read('docs/spec.md');
 for(const term of ['Feature 1 (B2B auth)','Feature 2 (cached search)','Feature 3 (distributed lock)','Feature 4 (saga compensation)','Feature 5 (forensic audit)'])assert.ok(spec.includes(term));
});

test('Updated Wave 1 contract: booking body binds flight and seat to lock',()=>{
 const booking=read('services/booking/index.js'),spec=read('docs/spec.md');
 assert.match(spec,/\{ "flightId": "string", "seatNumber": "string", "lockToken": "string", "fareQuoteId": "string", "paymentMethodId": "string" \}/);
 assert.match(booking,/flightId,seatNumber,lockToken,fareQuoteId,paymentMethodId/);
 assert.match(booking,/LOCK_FLIGHT_OR_SEAT_MISMATCH/);
});
test('Updated Wave 1 contract: airline booking command uses documented routing key and payload',()=>{
 const booking=read('services/booking/index.js'),airline=read('services/airline-connector/index.js'),spec=read('docs/spec.md');
 assert.match(spec,/command\.airline\.book/);
 assert.match(booking,/command\.airline\.book/);
 for(const field of ['commandId','sagaId','bookingId','correlationId','agencyId','flightId','seatNumber','fencingToken','idempotencyKey'])assert.ok(booking.includes(field),`missing ${field}`);
 assert.match(airline,/command\.airline\.book/);
});
test('Kong rate limiting is scoped per agency consumer and uses Redis-compatible Valkey',()=>{
 const kong=read('gateway/kong/kong.yml'),bootstrap=read('scripts/bootstrap.js');
 assert.match(kong,/limit_by: consumer/);assert.match(kong,/policy: redis/);
 assert.match(bootstrap,/limit_by:'consumer'/);assert.match(bootstrap,/policy:'redis'/);
});

test('Agency portal is served through Nginx and proxies API requests through Kong',()=>{
 const compose=read('docker-compose.yml'),nginx=read('frontend/nginx.conf'),html=read('frontend/index.html');
 assert.match(compose,/^  frontend:/m);assert.match(compose,/8080:80/);assert.match(nginx,/proxy_pass http:\/\/kong:8000\//);assert.match(html,/Flight operations/);
});
test('Jaeger and OpenTelemetry tracing are enabled for every Node.js service',()=>{
 const compose=read('docker-compose.yml'),docker=read('Dockerfile'),instrumentation=read('instrumentation.js');
 assert.match(compose,/^  jaeger:/m);assert.match(compose,/16686:16686/);assert.match(docker,/--require \.\/instrumentation\.js/);
 for(const service of ['auth-service','search-service','booking-service','airline-connector','audit-service'])assert.ok(compose.includes(`OTEL_SERVICE_NAME: ${service}`),`${service} must export traces`);
 assert.match(instrumentation,/OTLPTraceExporter/);assert.match(instrumentation,/getNodeAutoInstrumentations/);
});


test('Grafana provisions metrics, logs and distributed tracing data sources',()=>{
 const ds=read('infrastructure/grafana/provisioning/datasources/datasources.yml');
 for(const name of ['Prometheus','Loki','Jaeger'])assert.ok(ds.includes(`name: ${name}`),`${name} datasource must be provisioned`);
});
test('Observability scrapes application and infrastructure exporters',()=>{
 const prom=read('infrastructure/prometheus/prometheus.yml'),compose=read('docker-compose.yml');
 for(const job of ['auth-service','search-service','booking-service','airline-connector','audit-service','kong-gateway','postgres','valkey','rabbitmq','node-exporter','cadvisor'])assert.ok(prom.includes(`job_name: ${job}`),`${job} must be scraped`);
 for(const service of ['node-exporter','cadvisor','postgres-exporter','valkey-exporter'])assert.match(compose,new RegExp(`^  ${service}:`,'m'));
});
test('Grafana dashboards cover app, infrastructure, logs, traces and business operations',()=>{
 const dir=path.join(root,'infrastructure/grafana/provisioning/dashboards');
 for(const f of ['aerobooking-overview.json','aerobooking-infrastructure.json','aerobooking-logs.json','aerobooking-traces.json','aerobooking-business.json'])assert.ok(fs.existsSync(path.join(dir,f)),`${f} must be provisioned`);
});
test('Business observability exposes cache, distributed lock, Saga and audit metrics',()=>{
 const common=read('packages/common/index.js'),search=read('services/search/index.js'),booking=read('services/booking/index.js'),audit=read('services/audit/index.js');
 for(const metric of ['aerobooking_fare_cache_requests_total','aerobooking_seat_lock_attempts_total','aerobooking_saga_bookings_total','aerobooking_audit_events_total'])assert.ok(common.includes(metric),`${metric} must exist`);
 assert.match(search,/fareCacheRequests/);assert.match(booking,/seatLockAttempts/);assert.match(booking,/sagaBookings/);assert.match(audit,/auditEvents/);
});
test('Prometheus alert rules cover availability, HTTP errors, latency and memory pressure',()=>{
 const alerts=read('infrastructure/prometheus/alerts.yml');
 for(const alert of ['AeroBookingTargetDown','AeroBookingHighHttp5xxRate','AeroBookingHighHttpP95','AeroBookingHostMemoryHigh'])assert.ok(alerts.includes(alert),`${alert} must be defined`);
});

test('Complete scope: transactional outbox has retry metadata and backoff relay',()=>{
 const sql=read('infrastructure/postgres/init.sql'),booking=read('services/booking/index.js');
 for(const field of ['attempts','available_at','last_error','locked_at'])assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS ${field}`)||sql.includes(`${field} `));
 assert.match(booking,/FOR UPDATE SKIP LOCKED/);assert.match(booking,/2\*\*Math\.min\(attempts,8\)/);assert.match(booking,/published_at=now\(\)/);
});
test('Complete scope: reconciliation is protected by admin scope and report-first',()=>{
 const booking=read('services/booking/index.js'),module=read('packages/reconciliation.js');
 assert.match(booking,/v1\/admin\/reconciliation\/run/);assert.match(booking,/requireScope\('admin'\)/);assert.match(booking,/REPORT_ONLY/);assert.match(module,/COMPENSATED_WITHOUT_REFUND/);
});
test('Complete scope: authentication endpoint has Redis-backed brute-force throttling',()=>{
 const auth=read('services/auth/index.js');assert.match(auth,/auth:attempt:/);assert.match(auth,/AUTH_RATE_LIMITED/);
});
test('Complete scope: circuit breaker state and transition metrics are exported',()=>{
 const airline=read('services/airline-connector/index.js');assert.match(airline,/CircuitBreaker/);assert.match(airline,/aerobooking_airline_circuit_open/);assert.match(airline,/breaker\.on\('open'/);
});
test('Complete scope: reliability dashboard and alerts are provisioned',()=>{
 assert.ok(fs.existsSync(path.join(root,'infrastructure/grafana/provisioning/dashboards/aerobooking-reliability.json')));
 const alerts=read('infrastructure/prometheus/alerts.yml');for(const a of ['AeroBookingAirlineCircuitOpen','AeroBookingOutboxPublishFailures','AeroBookingReconciliationFindings'])assert.ok(alerts.includes(a));
});

test('Kong bootstrap preserves protected reconciliation route across startup regeneration',()=>{
 const bootstrap=read('scripts/bootstrap.js'),kong=read('gateway/kong/kong.json');
 assert.match(bootstrap,/v1\/admin\/reconciliation/);assert.match(kong,/v1\/admin\/reconciliation/);
 assert.match(bootstrap,/booking-routes/);assert.match(bootstrap,/jwt-revocation/);
});

test('Airline connector supports deterministic failure injection for circuit-breaker demos',()=>{
 const airline=read('services/airline-connector/index.js'),compose=read('docker-compose.yml');
 assert.match(airline,/AIRLINE_SIMULATE_FAILURE/);assert.match(compose,/AIRLINE_SIMULATE_FAILURE/);
});
