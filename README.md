# Large-Scale CSV Export Service

A high-performance, containerized data export service that asynchronously streams millions of PostgreSQL rows to CSV files with real-time progress tracking, backpressure handling, and resumable downloads.

## Features

- **Async Streaming** — Exports millions of rows without loading them into memory using PostgreSQL cursors
- **Progress Tracking** — Real-time progress updates via polling endpoint
- **Backpressure Handling** — Write stream drain events prevent memory overflow
- **Resumable Downloads** — HTTP Range header support for partial content downloads
- **Gzip Compression** — On-the-fly gzip compression via Accept-Encoding header
- **Cancellation** — Graceful job cancellation with cleanup of temporary files
- **Concurrent Exports** — Handles multiple export jobs simultaneously with worker pool
- **Custom Formatting** — Configurable delimiter, quote character, and column selection
- **Memory Efficient** — Runs within a 150MB container memory limit

## Architecture

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│   Client     │────▶│  Express API    │────▶│  Job Manager │
│  (curl/UI)   │◀────│  (routes.js)    │     │  (in-memory) │
└─────────────┘     └─────────────────┘     └──────┬───────┘
                                                    │
                                            ┌───────▼───────┐
                                            │ Export Worker  │
                                            │ (cursor-based │
                                            │  streaming)   │
                                            └───────┬───────┘
                                                    │
                           ┌────────────────────────┼────────────────┐
                           │                        │                │
                    ┌──────▼──────┐          ┌──────▼──────┐  ┌─────▼─────┐
                    │  PostgreSQL  │          │  CSV File    │  │  Progress │
                    │  (10M rows)  │          │  (streamed)  │  │  Updates  │
                    └─────────────┘          └─────────────┘  └───────────┘
```

## Quick Start

### Prerequisites
- Docker and Docker Compose installed

### Setup & Run

```bash
# 1. Clone the repository
git clone <repository-url>
cd large-scale-csv-export

# 2. Copy environment variables
cp .env.example .env

# 3. Build and start all services
docker-compose up --build -d

# 4. Wait for services to be healthy (DB seeding takes a few minutes)
docker-compose ps

# 5. Verify the database is seeded
docker-compose exec db psql -U exporter -d exports_db -c "SELECT COUNT(*) FROM users;"
# Expected: 10000000
```

## API Reference

### Health Check
```
GET /health
Response: 200 { "status": "ok" }
```

### Initiate Export
```
POST /exports/csv?country_code=US&min_ltv=500&columns=id,email,country_code&delimiter=,&quoteChar="

Response: 202
{
  "exportId": "uuid",
  "status": "pending"
}
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `country_code` | string | — | Filter by 2-letter country code |
| `subscription_tier` | string | — | Filter by tier (free, basic, premium, enterprise) |
| `min_ltv` | number | — | Minimum lifetime value filter |
| `columns` | string | all | Comma-separated column names |
| `delimiter` | char | `,` | CSV field delimiter |
| `quoteChar` | char | `"` | CSV quote character |

### Check Export Status
```
GET /exports/{exportId}/status

Response: 200
{
  "exportId": "uuid",
  "status": "processing",
  "progress": {
    "totalRows": 10000000,
    "processedRows": 2500000,
    "percentage": 25
  },
  "error": null,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "completedAt": null
}
```

### Download Export
```
GET /exports/{exportId}/download

Headers:
  Content-Type: text/csv
  Content-Disposition: attachment; filename="export_{id}.csv"
  Accept-Ranges: bytes
  Content-Length: <file size>

# Resumable download
GET /exports/{exportId}/download
Range: bytes=0-1023
→ 206 Partial Content

# Gzip compressed
GET /exports/{exportId}/download
Accept-Encoding: gzip
→ Content-Encoding: gzip
```

### Cancel Export
```
DELETE /exports/{exportId}
Response: 204 No Content
```

## Environment Variables

See [.env.example](.env.example) for all required variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | 8080 | Application port |
| `DB_HOST` | db | PostgreSQL host |
| `DB_PORT` | 5432 | PostgreSQL port |
| `DB_USER` | exporter | Database user |
| `DB_PASSWORD` | secret | Database password |
| `DB_NAME` | exports_db | Database name |
| `DATABASE_URL` | — | Full connection string |
| `EXPORT_STORAGE_PATH` | /app/exports | CSV file storage path |

## Project Structure

```
.
├── docker-compose.yml     # Service orchestration
├── Dockerfile             # App container definition
├── .env.example           # Environment variable template
├── package.json           # Node.js dependencies
├── seeds/
│   └── init.sql           # Database schema + 10M row seed
└── src/
    ├── index.js           # Express server entry point
    ├── db.js              # PostgreSQL connection pool
    ├── jobManager.js      # In-memory job queue with concurrency control
    ├── exportWorker.js    # Cursor-based streaming export worker
    └── routes.js          # API route handlers
```

## Technical Details

### Memory Efficiency
The app container is limited to **150MB** of memory. This is achieved by:
1. **PostgreSQL Cursors** — `DECLARE CURSOR` + `FETCH 5000` reads rows in small batches
2. **Stream Backpressure** — The worker awaits `drain` events on the write stream before fetching more data
3. **No Buffering** — Data flows directly from cursor → CSV formatter → file stream

### Database Seeding
The 10M rows are generated using PostgreSQL's `generate_series()` function in batches of 500K for optimal performance. Data includes randomized:
- Country codes (25 countries)
- Subscription tiers (free, basic, premium, enterprise)
- Lifetime values ($0 - $5000)
- Signup dates (within last 3 years)

## License
MIT
