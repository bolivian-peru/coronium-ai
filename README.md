# coronium-ai

[![ci](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/bolivian-peru/coronium-ai/actions/workflows/ci.yml)
[![npm coronium-cli](https://img.shields.io/npm/v/coronium-cli.svg?label=coronium-cli)](https://www.npmjs.com/package/coronium-cli)
[![npm coronium-mcp](https://img.shields.io/npm/v/coronium-mcp.svg?label=coronium-mcp)](https://www.npmjs.com/package/coronium-mcp)
[![npm coronium-sdk](https://img.shields.io/npm/v/coronium-sdk.svg?label=coronium-sdk)](https://www.npmjs.com/package/coronium-sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Agent-native interfaces to [Coronium](https://coronium.ai) — a CLI for humans, an MCP server for AI hosts, a typed SDK for everyone else, and a local mock API to test against. Three published packages, one OpenAPI spec, seven verbs.

```
coronium-ai/
├── openapi.yaml                 ← source of truth, hand-authored, frozen on v0.1.0
├── llms.txt                     ← agent self-discovery (will be served at coronium.ai/llms.txt)
├── AGENTS.md                    ← agent host instructions (will be served at coronium.ai/AGENTS.md)
├── packages/
│   ├── sdk-ts/                  ← coronium-sdk — typed TypeScript client
│   ├── cli/                     ← coronium-cli   — `coronium proxy get …`
│   └── mcp/                     ← coronium-mcp   — MCP server (Claude / Cursor / Windsurf)
├── apps/
│   └── api/                     ← coronium-mock-api — local Express mock for testing
├── scripts/
│   └── doctor.mjs               ← pre-publish sanity check
└── .github/workflows/ci.yml     ← typecheck + build + test + doctor + dry-run publish
```

---

## Two install commands — that's the entire pitch

```bash
# Human developer
npm install -g coronium-cli
coronium init
coronium proxy get --country US --type 5g

# AI agent (Claude Code / Claude Desktop / Cursor / Windsurf)
claude mcp add coronium npx -y coronium-mcp
# (set CORONIUM_API_KEY in the MCP env)
```

---

## Local development — full end-to-end test in one terminal

The mock API at `apps/mock-api/` implements every verb in `openapi.yaml`. You can run the entire stack on your laptop with no production dependencies. The real API at `apps/api/` is what gets deployed to `api.coronium.ai`.

```bash
# One-time setup
pnpm install
pnpm build

# Terminal A — boot the mock API
pnpm dev:api
# → listening on http://127.0.0.1:5050

# Terminal B — point the CLI at the mock and run the hero path
export CORONIUM_BASE_URL=http://127.0.0.1:5050/v1
node packages/cli/dist/index.js init                            # mints a fake key
node packages/cli/dist/index.js balance
node packages/cli/dist/index.js tariffs --country US
node packages/cli/dist/index.js proxy get --country US --type 5g
node packages/cli/dist/index.js proxy list
node packages/cli/dist/index.js proxy rotate <id>
node packages/cli/dist/index.js proxy release <id>

# Or link it globally for convenience
cd packages/cli && npm link
coronium balance                                                # global `coronium` now works
```

Mock state is in-memory and resets on every restart — no persistence, no real charges, no real proxies.

To test against a real backend later: change `CORONIUM_BASE_URL` to point at the production URL.

---

## Tests

```bash
pnpm test          # one-shot — runs all 21 vitest cases
pnpm test:watch    # interactive
pnpm typecheck     # tsc --noEmit on every package
pnpm doctor        # pre-publish sanity (secrets / prod IPs / leftover .tgz / dist hygiene)
```

The SDK suite (`packages/sdk-ts/test/`) boots the mock app on a random port and exercises every verb end-to-end. The CLI suite shells out to `dist/index.js` and checks `--help` / `--version` output. The MCP suite parses the built bundle to verify all 8 tools are registered.

---

## The 7 verbs

| Verb | CLI | REST | MCP tool |
|---|---|---|---|
| balance | `coronium balance` | `GET /v1/balance` | `balance_get` |
| deposit | `coronium deposit` | `POST /v1/deposit/address` | `deposit_address` |
| tariffs | `coronium tariffs` | `GET /v1/tariffs` | `tariff_list` |
| buy proxy | `coronium proxy get` | `POST /v1/proxies` | `proxy_get` |
| list | `coronium proxy list` | `GET /v1/proxies` | `proxy_list` |
| rotate | `coronium proxy rotate <id>` | `POST /v1/proxies/{id}/rotate` | `proxy_rotate` |
| replace | `coronium proxy replace <id>` | `POST /v1/proxies/{id}/replace` | `proxy_replace` |
| release | `coronium proxy release <id>` | `DELETE /v1/proxies/{id}` | `proxy_release` |

Same surface in all three. If a verb stops being needed, it's deprecated in all three at once. If a verb is added, same.

---

## Publishing checklist

Before you `pnpm publish:alpha`:

1. **Log in** — `npm login` (uses 2FA if your account has it on).
2. **Bump the version** if you've changed anything since the last publish — edit each `packages/*/package.json` `version` field. Pre-1.0 we publish under the `alpha` tag.
3. **Run the doctor** — `pnpm doctor` (also runs as part of `publish:dry`).
4. **Dry-run** — `pnpm publish:dry` (verifies tarballs, file lists, no leftover debris).
5. **Real publish** — `pnpm publish:alpha`.

The doctor catches: missing `dist/`, leftover `.tgz`, secret-shaped strings, production IPs/hostnames, missing LICENSE, wrong `publishConfig.access`. CI runs it on every push.

When you're ready for `latest` instead of `alpha`, change `publish:alpha` to `pnpm -r ... publish --access public` (no `--tag`).

---

## Embedding in coronium.ai

To embed the same agent surface in your `coronium.ai` site:

1. **Install commands** — show `npm install -g coronium-cli` and `claude mcp add coronium npx -y coronium-mcp` prominently above the fold.
2. **Live demo** — the existing CLI chat agent (currently at `dashboard.coronium.io/cli`) is the demo. Move that route to `coronium.ai/cli` or embed the same React component.
3. **Static drops** — copy `llms.txt` and `AGENTS.md` to your site root so they're reachable at `coronium.ai/llms.txt` and `coronium.ai/AGENTS.md`.
4. **OpenAPI** — host `openapi.yaml` at `api.coronium.ai/openapi.yaml`. Tools like Swagger UI / Redoc render it with one line.

---

## License

Apache-2.0. See `LICENSE` in each package directory.

## Reference

- Marketing: <https://coronium.ai>
- Customer dashboard: <https://dashboard.coronium.io>
- API spec (live): <https://api.coronium.ai/openapi.yaml>
- Agent discovery: <https://coronium.ai/llms.txt>, <https://coronium.ai/AGENTS.md>
