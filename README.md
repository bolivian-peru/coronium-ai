# coronium.ai

[![ci](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml)

A peer proxy network, built from an empty repository. Device owners connect devices with an open agent; buyers and their AI agents send web traffic through those devices and pay per GB.

The server side is Rust. The device agent is Go, so it can be built for routers.

## Status

The build goes in phases, and each phase ends with a check a program can evaluate. Nothing here is called working until its check has passed.

| Phase | State |
|---|---|
| 0. Protocol and proof harness | check passing: the vectors pass in Rust and Go, and the ledger refuses a lost batch and a duplicate batch |
| 1. One request end to end | not started |
| 2. The chat | not started |
| 3. Supply and pay | not started |
| 4. MCP and identities | not started |
| 5. Scale | not started |

## Parts

| Part | What it is |
|---|---|
| [`proto`](./proto) | The wire protocol between agent, relay and edge: [the rules](./proto/PROTOCOL.md), [the test vectors](./proto/vectors) and the Rust implementation |
| [`coordinator`](./coordinator) | The usage ledger, in integer bytes, on Postgres |
| [`harness`](./harness) | The proof harness: a simulated device and a load generator |
| [`agent`](./agent) | The device agent, in Go |

The protocol is published so that anyone can write or change an agent and stay compatible: an implementation conforms when it passes every vector.

## Running the check

One script checks everything, and CI runs the same one.

```bash
docker run -d --name coronium-dev-db -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:54329:5432 postgres:17-alpine
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
scripts/check.sh
```

It needs Rust (the version in `rust-toolchain.toml`), Go (the version in `agent/go.mod`) and that Postgres.

## Looking for coronium-sdk or coronium-cli?

Their source lived in this repository until commit [`a0df5c1`](https://github.com/bolivian-peru/coronium-ai/tree/a0df5c1). Both packages stay on npm at 1.0.0.

## Support

hello@coronium.io

## License

[Apache-2.0](./LICENSE).
