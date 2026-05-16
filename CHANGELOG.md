# Changelog

## 0.3.0

- New `set` invalidation event type. When a `getOrSet` loader returns a value, the cache broadcasts the value over the event bus so every connected peer populates its L1 — peers no longer need to repeat the loader call.
- New `HybridCacheOptions.broadcastSet` (default `true` when an `eventBus` is configured). Set `false` to keep the older delete-only fanout semantics.
- New observability events: `set:broadcast` and `set:received`.
- Direct `cache.set()` calls still do not broadcast — only `getOrSet` loader successes do.
- Public type export: `SetEvent`.

## 0.1.6

- Relaxed lru-cache dependency to avoid ETARGET install failures on deploy environments.
- No runtime API changes.
