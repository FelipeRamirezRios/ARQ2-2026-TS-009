# AeroBooking — alcance Complete

## 1. Objetivo y requisitos preservados

La implementación conserva el Caso 9: AeroBooking conecta agencias B2B con APIs de aerolíneas. Los riesgos principales son (a) exceso de consultas a aerolíneas y bloqueos por rate limit y (b) doble venta de un asiento por concurrencia entre agencias.

| Requisito | Implementación conservada |
|---|---|
| Autenticación B2B | OAuth2 client credentials, secretos bcrypt, JWT RS256, scopes, rotación/revocación de API keys y revocación de JWT |
| Búsqueda con caché | Cache-aside/single-flight en Valkey, expiración de cotizaciones y token bucket por aerolínea |
| Bloqueo distribuido | Valkey `SET NX PX`, token de propietario, fencing token y validación en Airline Connector |
| Compra Saga | Orquestación asíncrona, reserva de saldo, confirmación/rechazo de aerolínea y compensación idempotente |
| Auditoría | Eventos centralizados append-only en PostgreSQL con cadena SHA-256 |

## 2. Funcionalidades Complete añadidas/reforzadas

### 2.1 Transactional Outbox

La creación de la reserva y el evento `booking.start` se escriben dentro de la misma transacción PostgreSQL. El relay usa `FOR UPDATE SKIP LOCKED`, publica con confirmación de RabbitMQ y marca el evento como publicado después del ACK del broker. Los fallos aumentan `attempts`, guardan `last_error` y posponen `available_at` con backoff exponencial (máximo 256 s en esta configuración). La entrega es **at-least-once**: los consumidores deben mantener idempotencia mediante Inbox/`message_id`; no se promete exactly-once distribuido.

### 2.2 Reconciliation

`POST /v1/admin/reconciliation/run` ejecuta un escaneo de hasta 5.000 reservas de los últimos 90 días. Detecta, entre otros, reserva confirmada sin captura, compra compensada sin reembolso y diferencias entre estado de Saga y reserva. Persiste cada corrida en `reconciliation_runs` y emite auditoría.

**Seguridad financiera:** esta versión funciona en modo `REPORT_ONLY`. No inventa capturas ni reembolsos ni modifica saldos desde el proceso de conciliación. Los hallazgos críticos requieren revisión/acción controlada. La compensación automática propia del flujo Saga sigue activa cuando la aerolínea rechaza la reserva.

`GET /v1/admin/reconciliation/runs` devuelve las últimas 50 corridas. Ambos endpoints requieren scope `admin`.

### 2.3 Circuit Breaker

El Airline Connector conserva Opossum con umbral de errores, volumen mínimo, timeout y reset. Si el circuito de confirmación está abierto, responde `AIRLINE_UNKNOWN`; no dispara un reembolso mientras el resultado remoto sea incierto. La recuperación consulta el estado de la interacción antes de confirmar o compensar. Se exponen `aerobooking_airline_circuit_open` y `aerobooking_airline_circuit_transitions_total`. Para demostrar fallos: establecer `AIRLINE_SIMULATE_FAILURE=true` en `.env`, recrear `airline-connector` (`docker compose up -d --force-recreate airline-connector`), generar al menos tres intentos de compra con asientos distintos y revisar el circuito/Jaeger/Grafana. Volver a `false` y recrear el servicio para recuperar el simulador.

### 2.4 Seguridad

El endpoint de emisión de tokens aplica límite distribuido por `client_id` e IP: por defecto 20 intentos/minuto usando Valkey. El sistema falla cerrado si Valkey no está disponible. Se mantienen scopes, hash bcrypt, rotación con ventana de gracia, revocación y rate limit de Kong por consumidor/agencia.

### 2.5 Testing

Se agregaron pruebas unitarias puras para el clasificador de conciliación y pruebas de arquitectura para Outbox, Circuit Breaker, seguridad, endpoints administrativos, dashboard y alertas. Las pruebas no requieren servicios externos.

### 2.6 Grafana

Se agrega el dashboard **AeroBooking | Reliability & Reconciliation** con estado/transiciones del circuito, fallos del relay y hallazgos de conciliación. Prometheus incorpora alertas para circuito abierto, errores del Outbox y hallazgos críticos.

## 3. Stack gratuito/open source

Node.js, Express/Fastify, PostgreSQL, Valkey, RabbitMQ, Kong Gateway OSS, Prometheus, Grafana OSS, Loki, Jaeger, OpenTelemetry, Nginx y Opossum. No se requiere una API comercial ni una cuenta de telemetría paga; el conector de aerolínea sigue siendo un simulador local.

## 4. Instalación en Windows (PowerShell)

1. Instalar Docker Desktop con backend WSL2 y Git (opcional).
2. Descomprimir el ZIP y abrir PowerShell en la carpeta `ARQ2-2026-TS-009-prototipo`.
3. Copiar `.env.example` a `.env` y cambiar secretos antes de exponer el entorno.
4. El contenedor `keygen` genera un par RSA local en `secrets/` si no existe. Las claves privadas no se distribuyen dentro del ZIP.
5. Si ya existe una base de datos de una versión anterior, aplicar la migración **antes** de actualizar los servicios:

```powershell
docker compose up -d postgres
Get-Content .\infrastructure\postgres\migrations\002-complete-hardening.sql | docker compose exec -T postgres psql -U aerobooking -d booking_db
docker compose up --build -d
```

Para una instalación limpia, `docker compose up --build -d` ejecuta `infrastructure/postgres/init.sql` al crear el volumen por primera vez. No borres `postgres_data` si necesitas conservar reservas/datos.

6. Verificar contenedores:

```powershell
docker compose ps
docker compose logs --tail=100 booking-service airline-connector auth-service
```

## 5. Pruebas

Pruebas locales sin Docker:

```powershell
npm install
npm test
```

Prueba smoke de integración (requiere stack levantado):

```powershell
npm run test:smoke
```

Flujo demostrativo:
- Buscar BOG–MDE y repetir la búsqueda para observar el caché.
- Bloquear el asiento 14A; intentar bloquearlo desde otra agencia y comprobar `409`.
- Comprar 14A para confirmar; usar 12A para provocar rechazo y observar compensación.
- Consultar el estado de reserva y auditar por `correlationId`.
- Ejecutar conciliación con token administrador:

```powershell
$admin = @{grant_type='client_credentials';client_id='demo-admin';client_secret='demo-admin-secret-change-me';scope='admin'} | ConvertTo-Json
$token = (Invoke-RestMethod -Method Post -Uri http://localhost:8000/v1/auth/token -ContentType 'application/json' -Body $admin).access_token
Invoke-RestMethod -Method Post -Uri http://localhost:8000/v1/admin/reconciliation/run -Headers @{Authorization="Bearer $token"}
Invoke-RestMethod -Uri http://localhost:8000/v1/admin/reconciliation/runs -Headers @{Authorization="Bearer $token"}
```

## 6. Consolas

| Herramienta | URL local |
|---|---|
| Portal agencias | http://localhost:8080 |
| Kong | http://localhost:8000 |
| Grafana | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| Jaeger | http://localhost:16686 |
| Loki | http://localhost:3100 |
| RabbitMQ | http://localhost:15672 |

Credenciales de demostración: Grafana `admin/admin`; RabbitMQ `aerobooking/aerobooking_dev`; agencia demo `demo-client/demo-secret-change-me`; administrador demo `demo-admin/demo-admin-secret-change-me`. Son exclusivamente locales: cambiar antes de cualquier despliegue compartido.

## 7. Limitaciones conocidas y criterios de producción

- La aerolínea es simulada; no se conectan APIs reales ni se procesa dinero real.
- El ledger es demostrativo y no reemplaza un PSP ni conciliación bancaria.
- El Outbox ofrece entrega at-least-once; se requiere idempotencia de consumidores.
- La conciliación informa y prioriza; no aplica correcciones financieras automáticas.
- La topología Docker Compose es local, no HA. Para producción: TLS, secretos gestionados, réplicas, backups/restauración probados, PostgreSQL HA, Valkey Sentinel/Cluster, RabbitMQ cluster, alertas con receptor, rotación de claves, hardening Kong y pruebas de carga/caos.
- Los dashboards dependen de que Prometheus esté scrapeando y de que haya tráfico de aplicación.

## 8. Archivos principales cambiados

- `services/booking/index.js`: endpoints administrativos, métricas de conciliación y relay Outbox con reintentos.
- `services/auth/index.js`: throttling distribuido de intentos de token.
- `services/airline-connector/index.js`: métricas de estado/transiciones del Circuit Breaker.
- `packages/reconciliation.js`: clasificador puro de inconsistencias.
- `infrastructure/postgres/init.sql` y `migrations/002-complete-hardening.sql`: esquema Outbox y registro de conciliaciones.
- `gateway/kong/kong.json`: ruta protegida de conciliación.
- `infrastructure/prometheus/alerts.yml` y dashboard `aerobooking-reliability.json`.
- `tests/reconciliation.test.js` y ampliación de `tests/architecture.test.js`.

## Enterprise extension

The additional CQRS/Event Store, PNR, passenger, e-ticket, idempotency fingerprint, API versioning, OpenAPI contract, k6 load test, controlled chaos, backup/restore and Enterprise Grafana dashboard are documented in [`ENTERPRISE-IMPLEMENTATION.md`](ENTERPRISE-IMPLEMENTATION.md). Architectural decisions are recorded in ADRs 008–011.
