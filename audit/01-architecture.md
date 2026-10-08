# Architecture and invariants

The implementation remains an in-process TypeScript library with optional Redis/KV and event transports. This audit retains that deployment model. The diagrams describe final intended and regression-tested transitions; adapter/topology limitations are explicit in the correctness/readiness reports.

## Read

```mermaid
flowchart TD
  A[Application get key] --> O[Check open state and local invalidation trust]
  O --> N{Negative record still live?}
  N -- yes --> U[Return undefined]
  N -- no --> L{Valid L1 encoded record?}
  L -- yes --> D[Bounded decode and TTL check]
  D --> R[Return value; optionally remember eligible stale copy]
  L -- no --> G[Capture per-key revision and storage generation]
  G --> B[Bounded L2 gate and circuit breaker]
  B --> S[Authoritative encoded snapshot plus remaining TTL]
  S --> V{Valid decode, TTL, revision and trust?}
  V -- yes --> P[Promote without extending source TTL]
  P --> R
  V -- no --> U
```

`get` preserves read-only lookup semantics; it does not independently start a loader. A valid serialized `null` is a hit. Corrupt/unsupported/oversize records are internal misses.

## Write

```mermaid
flowchart TD
  A[Application set key/value] --> V[Validate options and capture same-key mutation revision]
  V --> E[Encode for configured tier and admission budget]
  E --> L[L1 commit while revision current]
  E --> R[Bounded L2 write]
  R --> F[Redis v2 SET and lease revocation in one Lua execution]
  L --> C[Return when configured writes settle]
  F --> C
  C --> B[Loaded-value broadcast is separate; direct set semantics preserved]
```

Independent keys do not invalidate each other's ordinary fills. A same-key mutation or a broad invalidation invalidates older guards.

## Miss and singleflight

```mermaid
flowchart TD
  A[getOrSet] --> I{Existing same-key leader?}
  I -- yes --> W{Follower slot and memory budget?}
  W -- yes --> J[Join leader; release reservation on completion/error]
  W -- no --> X[Typed controlled overload]
  I -- no --> R[Read L1/L2; recheck singleflight after await]
  R --> H{Hit?}
  H -- yes --> Y[Return cached value]
  H -- no --> L[Reserve finite leader and origin/L2 coordination capacity]
  L --> K{Distributed lease configured?}
  K -- yes --> A2[Acquire per-key lease or bounded wait for winner]
  K -- no --> O[Admit origin load]
  A2 -- owner --> O
  A2 -- winner published --> Y
  A2 -- unavailable --> U[Bounded fail-open load; protected publication suppressed]
  O --> Q[Recheck current cache, mutation, cancellation and lease after admission]
  Q --> DB[Read-only origin loader with hard deadline]
  DB --> PUB[Publish only if revision/lease still current]
  U --> DB
  PUB --> Y
```

A timed-out caller does not release an origin or network slot while the underlying work is still running. A request cannot bypass observed lock contention simply because a waiter deadline expired, except under the explicitly configured weaker `onTimeout:'load'` policy; even that path cannot publish to protected v2 state without ownership.

## Refresh and stale fallback

```mermaid
flowchart TD
  F[Fresh entry remembered] --> S[Separate bounded encoded stale record with its own deadline]
  E[Normal entry expires] --> M[Next getOrSet follows the miss path]
  M --> L[One admitted loader]
  L -- success/current --> N[Publish fresh result; replace eligible stale record]
  L -- error or soft/hard deadline --> P{Fail-safe allowed, trusted and stale deadline valid?}
  P -- yes --> R[Serve safely permitted stale]
  P -- no --> X[Propagate typed failure]
  I[Invalidation / trust gap / close] --> C[Drop stale eligibility]
```

There is no new background refresh service, probabilistic early refresh, priority scheduler or source-authority policy introduced by this change. Stale authorization data is unsafe unless the application explicitly permits it. Optional refresh techniques are research decisions/backlog, not benchmarked production capabilities.

## Invalidation and recovery

```mermaid
flowchart TD
  A[Direct key/pattern invalidation] --> M[Advance local revision; remove L1/stale/negative/inflight records]
  M --> L[Delete shared data and fence matching v2 leases]
  L --> P[Publish bounded scoped invalidation event]
  P --> R[Peer wire/metadata validation and scope check]
  R --> D[Bounded dedupe and local invalidation]
  H[Peer set hint] --> V[Read current authoritative L2 instead of trusting hint value]
  V --> D2[Bounded decode; subtract elapsed TTL; promote if current]
  G[Transport loss, invalid delivery or queue overflow] --> U[Mark local state untrusted and flush eligible state]
  U --> S[Actual subscription recovery / drained-gap notification]
  S --> C[Conservative L1 reconciliation before trust restoration]
```

Ordinary Pub/Sub is not durable. Reconciliation after an observed subscriber gap does not solve an event lost only at the publisher, asynchronous Redis failover or a globally ordered source update protocol. Pattern deletion remains bounded batched enumeration, not an atomic namespace snapshot.

## Failure

```mermaid
flowchart TD
  A[Redis/origin/event failure] --> L{Resource/deadline budget remains?}
  L -- no --> S[Shed/reject predictably; retain slots until actual work settles]
  L -- yes --> C{L2/event circuit callable?}
  C -- no --> F[Bounded fail-open read-only origin path]
  C -- yes --> T[Attempt operation; record bounded outcome]
  T -- failure --> B[Open breaker after threshold]
  B --> H[One half-open probe after cooldown]
  F --> P{Eligible trusted stale allowed?}
  S --> P
  P -- yes --> R[Stale response]
  P -- no --> E[Controlled error or miss]
```

## Shutdown

```mermaid
flowchart TD
  A[close] --> C[Mark closed; advance broad publication epoch]
  C --> Q[Reject queued work; stop maintenance and observers]
  Q --> L[Abort cooperative leaders; block all late publication]
  L --> E[Clear owned resident/stale/negative/generation/dedupe state]
  E --> T[Disconnect owned buses/managed clients within teardown deadlines]
  T --> Z[Closed; diagnostics remain readable]
  L --> R[Already active ignoring-abort loaders may answer original callers within original deadline]
  R --> S[Release actual active reservations when underlying work settles]
```

Closing does not falsely report zero retained active work while an ignoring-abort origin/client still owns it. Caller-provided client ownership is respected. New cache operations reject after terminal closure; old active success responses retain their compatibility contract and cannot repopulate closed state.

## Entry state model

```mermaid
stateDiagram-v2
  [*] --> Absent
  Absent --> Loading: admitted miss
  Loading --> Fresh: current successful protected publication
  Loading --> Negative: undefined result / bounded negative TTL
  Loading --> Absent: revoked revision / invalid record / no publication
  Fresh --> Absent: TTL expiry
  Fresh --> Invalidated: mutation or event
  Negative --> Invalidated: mutation or event
  Invalidated --> Absent: older work cannot republish
  Fresh --> Untrusted: delivery gap
  Negative --> Untrusted: delivery gap
  Untrusted --> Absent: conservative recovery flush
  Loading --> Closed: shutdown fences publication
  Fresh --> Closed: shutdown
  Absent --> Closed: shutdown
  Closed --> [*]
```

The tests cover scheduled race transitions and seeded wildcard semantics. This is a small state model, not a formal model-checking proof of Redis failover or arbitrary custom asynchronous adapter correctness.

