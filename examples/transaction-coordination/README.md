# Ticketing transaction coordination

Run this self-contained seat allocation demo after building the package:

```sh
npm run build
node --import tsx examples/transaction-coordination/index.ts
```

The demo races two buyers for the same movie seat, retries the winning
reservation, confirms it through a fake idempotent payment provider, and
retries the payment. The durable adapter claims the seat row separately from
the request idempotency key, so a second buyer cannot hold the same seat.

`FakeDurableTicketDb` models the short transactions that a production adapter
must implement with a database primary and unique constraints. `FakePrimaryRedis`
models the one-record Redis state machine so the example does not require a
Redis process. The real integration uses `RedisOperationTransport` with an
explicit primary client configured with offline queueing and uncertain command
resends disabled.

Redis leases coordinate work only. A provider response can be unknown after a
crash; recovery must query the durable operation and provider using the same
stable provider identity. This example makes no exactly-once claim across
Redis, a database, and an external payment provider.
