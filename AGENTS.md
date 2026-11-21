# AGENTS.md - coronium.ai

Instructions for AI coding agents working in this repository.

## What this is

coronium.ai is a peer proxy network. Device owners connect devices with an open agent; buyers and their AI agents send web traffic through those devices and pay per GB. The server side is Rust, the device agent is Go.

| Part | What it does | State |
|---|---|---|
| `proto` | The wire protocol between agent, relay and edge: `PROTOCOL.md`, the vectors and the Rust implementation | phase 0 |
| `coordinator` | Accounts, routing and the ledger. The only writer of usage and money. Postgres | phase 0: the usage ledger |
| `harness` | The proof harness: a simulated device and a load generator | phase 0 |
| `agent` | The device agent, in Go | phase 0: the protocol package only |
| `relay`, `edge`, `web`, `mcp` | Not started | later phases |

## Rules for every change

1. **Keep it simple.** Reuse over duplicate, delete dead code, no speculative abstraction, no nested ternaries, match the neighbouring style. Build only what the current phase's check needs.
2. **Usage and money are integers.** Bytes, and USD micro-units. No float and no rounding anywhere in that path.
3. **One meter, at the edge.** No device, relay or other node ever reports its own usage or pay.
4. **Single-flight lives in the database** (a row lock, an advisory lock or a unique index), never in process memory.
5. **Strict input.** Unknown input is refused, never skipped. Every refusal and every error carries a `code`, a `cause` and a `fix`.
6. **The request path reads only memory.** No database or network round trip per request, no log line per request, bounded queues, small per-connection buffers, and a panic in one task never ends the process.
7. **Secrets stay out.** No secret, key value, customer detail or device address in code, tests, logs, docs or commit messages.
8. **Never say no to demand.** Nothing reports a country or a volume as unavailable; it is `on_request`, and the demand is recorded.
9. **Report what was measured.** Label a fact observed, derived or proposed. "Proven" is only for a gate that passed, and every figure names its hardware, node count and test length.
10. **Delete what you replace.** If a concept already has an object, extend it.
11. **The protocol is a contract.** `proto/PROTOCOL.md` and `proto/vectors/` change together, and only with the owner's agreement. An implementation is fixed to match them, never the reverse.

## Phases

Work goes in phases. Each ends with a check a program can evaluate, and no phase starts while the one before it is red.

| Phase | Check |
|---|---|
| 0. Protocol and proof harness | Vectors pass in Rust and Go; a lost batch and a duplicate batch are both refused by the ledger |
| 1. One request end to end | A fetch through a real device returns the page; bytes billed equal bytes carried; correctness, throughput and device-scale gates pass at 1k requests per second |
| 2. The chat | Every number on a card equals the API value; no secret in a stored turn; money needs a confirmed quote |
| 3. Supply and pay | New accounts are fallback supply; invented or padded traffic earns nothing; no held amount is paid early |
| 4. MCP and identities | A fixed set of agent tasks passes end to end; every tool call is logged |
| 5. Scale | 100k requests per second held for 30 minutes on stated hardware; a private device never serves a stranger |

## Working in this repository

- Run `scripts/check.sh` before every commit. CI runs the same script. It needs `cargo`, `go` and a Postgres in `DATABASE_URL`, and it fails when one is missing.
- Build and test one crate at a time while working: `cargo test -p coronium-proto`.
- The root `Cargo.toml` holds shared dependency versions. A crate uses `workspace = true` for those and adds its own for anything else.
- The Go agent uses the standard library only unless there is a measured need.
- Code style: named functions, explicit return types, comments that explain why.
- Copy style: short dashes only.
- A person approves anything hard to undo: money, deletion, a production release, a push to `main`.

## Support

hello@coronium.io
