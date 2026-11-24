import http from 'k6/http';
import { check, sleep } from 'k6';
export const options = { stages: [{ duration: '30s', target: 5 }, { duration: '60s', target: 20 }, { duration: '30s', target: 0 }], thresholds: { http_req_failed: ['rate<0.02'], http_req_duration: ['p(95)<750'] } };
const base = __ENV.BASE_URL || 'http://localhost:8000';
export function setup() {
  if (__ENV.AEROBOOKING_TOKEN) return { token: __ENV.AEROBOOKING_TOKEN };
  const credentials = { grant_type: 'client_credentials', client_id: __ENV.CLIENT_ID || 'demo-client', client_secret: __ENV.CLIENT_SECRET || 'demo-secret-change-me' };
  const response = http.post(`${base}/v1/auth/token`, JSON.stringify(credentials), { headers: { 'Content-Type': 'application/json' } });
  check(response, { 'token acquired': r => r.status === 200 });
  return { token: response.json('access_token') || '' };
}
export default function (data) {
  const r = http.get(`${base}/v2/bookings?limit=25&offset=0`, { headers: { Authorization: `Bearer ${data.token}` } });
  check(r, { 'CQRS collection responds': x => x.status === 200 });
  sleep(1);
}
