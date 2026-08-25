# LazyLayers Cache — Production-Grade Architecture Examples

This directory contains battle-tested, production-grade architectural examples for **`lazy-layers-cache`**, demonstrating single-server deployments (L1, L2, Hybrid L1+L2), multi-server distributed clusters across all 4 supported event bus transports, and a fullstack interactive application with **Hono.js** and **Vite.js**.

---

## 📁 Architecture Index

| Example | Topology | Transports / Layers | Key System Design Features |
|---|---|---|---|
| **[`01-single-server-l1-only/`](./01-single-server-l1-only/)** | Single Server | In-Memory LRU | Sub-microsecond reads (<1µs), in-flight herd collapse, negative caching, stale fallback, live dashboard |
| **[`02-single-server-l2-only/`](./02-single-server-l2-only/)** | Single Server | Redis L2 | Tiered compression (MsgPack, LZ4, Zstd), non-blocking cursor SCAN, circuit breaker fail-open |
| **[`03-single-server-hybrid-l1-l2/`](./03-single-server-hybrid-l1-l2/)** | Single Server | L1 RAM + L2 Redis | Two-tier stampede protection (Inflight promise + Redis Mutex), tier promotion, Prometheus metrics |
| **[`04-multi-server-event-buses/`](./04-multi-server-event-buses/)** | Multi-Server Cluster | Redis, RabbitMQ, NATS Core, NATS JetStream | Cross-node invalidation, `broadcastSet` L1 priming, monotonic generation fencing, duplicate dedupe |
| **[`fullstack-hono-vite/`](./fullstack-hono-vite/)** | Fullstack App | Hono.js + Vite.js UI | Interactive user query simulator, 50-request stampede trigger, live dashboard viewer at `/__lazylayers` |

---

## 🚀 Quick Start & Running Examples

### 1. Single Server — L1 In-Memory Only
```bash
npm run example:l1
```
- **Dashboard UI**: `http://127.0.0.1:7071/__lazylayers`
- **Prometheus Metrics**: `http://127.0.0.1:7071/__lazylayers/metrics`

### 2. Single Server — L2 Redis Only (Tiered Compression)
```bash
npm run example:l2
```
- **Dashboard UI**: `http://127.0.0.1:7072/__lazylayers`
- **Prometheus Metrics**: `http://127.0.0.1:7072/__lazylayers/metrics`

### 3. Single Server — Hybrid L1 + L2
```bash
npm run example:hybrid
```
- **Dashboard UI**: `http://127.0.0.1:7073/__lazylayers`
- **Prometheus Metrics**: `http://127.0.0.1:7073/__lazylayers/metrics`

### 4. Multi-Server Distributed Clusters (All 4 Event Buses)
```bash
# Run all 4 event buses sequentially
npm run example:events

# Or run a specific event bus:
npm run example:events:redis       # Redis Pub/Sub
npm run example:events:rabbit      # RabbitMQ Fanout Exchange
npm run example:events:nats-core   # NATS Core Subject Pub/Sub
npm run example:events:nats-js     # NATS JetStream Stream Broadcast
```

### 5. Fullstack Interactive Hono.js + Vite.js Application
```bash
npm run example:fullstack
```
- **Interactive Web App**: `http://localhost:5173`
- **Hono.js API Server**: `http://localhost:3000`
- **Built-in Observability Dashboard**: `http://127.0.0.1:7077/__lazylayers`
- **Prometheus Scrape Endpoint**: `http://127.0.0.1:7077/__lazylayers/metrics`
- **Default Dashboard Credentials**: `lazydev` / `lazydev`

---

## 🏛️ System Design Principles Demonstrated

### 1. Multi-Tier Cache Hierarchy
- **L1 RAM**: Sub-microsecond (<1µs) reads, zero serialization overhead, bounded LRU eviction.
- **L2 Redis**: Shared distributed persistence across node restarts and blue-green deployments.

### 2. Cache Stampede (Thundering Herd) Defense
- **Local In-Flight Coalescing**: Collapses thousands of concurrent callers within the same process onto a single loader promise.
- **Global Distributed Locks**: Redis distributed mutex ensures only one node computes heavy database aggregates across a scaled cluster.

### 3. Wire Footprint & Tiered Compression
- **Small (<256 B)**: Raw MessagePack (`HC1M`).
- **Medium (256 B - 4 KB)**: LZ4 compression (`HC1L`) for 60-80% size savings with instant decompression.
- **Large (>=4 KB)**: Zstandard / Zstd (`HC1Z`) or gzip (`HC1G`) for up to 92% bandwidth reduction on network links.

### 4. Cache Coherence & Monotonic Generation Fencing
- In distributed networks, slow packets can arrive out-of-order. Generation counters prevent stale `set` events from resurrecting previously deleted data.
