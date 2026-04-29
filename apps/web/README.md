# coronium-ai/apps/web — coronium.ai marketing site

Static HTML, no framework, no build step. Deploys to anywhere that serves files.

## Files

| File | URL | Purpose |
|---|---|---|
| `index.html` | `coronium.ai/` | Marketing landing page — hero + two install commands + features + verbs table + pricing |
| `free.html` | `coronium.ai/free` | Voucher-claim form — POSTs to `/v1/vouchers/claim-free` (backend endpoint TBD — task #144) |
| `llms.txt` | `coronium.ai/llms.txt` | Agent-discovery file (Mintlify/Cursor convention) |
| `AGENTS.md` | `coronium.ai/AGENTS.md` | Agent host instructions (copy of repo root) |
| `openapi.yaml` | `coronium.ai/openapi.yaml` | API spec (copy of repo root) |
| `vercel.json` | n/a | Vercel routing + security headers config |

## Deploy paths

### Vercel (current registrar — fastest path)

```bash
cd apps/web
npx vercel --prod
# Or: hook this directory to the existing coronium.ai Vercel project as the
# build/output dir. No build command needed; "framework preset: Other".
```

The `vercel.json` configures clean URLs (so `/free` works without `.html`),
adds caching for the discovery files, and sets security headers.

### Cloudflare Pages

```bash
cd apps/web
npx wrangler pages deploy . --project-name coronium-ai
```

### Netlify

```bash
cd apps/web
npx netlify deploy --prod --dir .
```

### Your own nginx

Just copy the directory:

```bash
rsync -av apps/web/ user@server:/var/www/coronium.ai/
```

…and point nginx at it with `try_files $uri $uri.html $uri/ =404;`.

## What's wired vs not (2026-04-29)

- **`/`, `/AGENTS.md`, `/llms.txt`, `/openapi.yaml`** — fully static, work today.
- **`/free`** — calls `POST /v1/vouchers/claim-free` on submit, which is **not yet implemented** in the backend (task #144 — Block L). Until that ships, the form will show a "Network error / api unreachable" message. Frontend is ready; just waiting on the endpoint.
- **Live demo embeds** (chat / signup) — the page links to `dashboard.coronium.io` for now. When task #146 ships the chat backend at `chat.coronium.ai`, an iframe demo can be embedded inline.

## Customization

The accent color (orange `#FF6B35`) is set as `--accent` in CSS variables. Swap it for whatever brand color, or add a logo by replacing the `.dot` div in the nav.

The page works in light + dark mode automatically via `prefers-color-scheme`.

## Update the discovery files

When `coronium-ai/llms.txt`, `AGENTS.md`, or `openapi.yaml` change in the repo root:

```bash
cp ../../AGENTS.md AGENTS.md
cp ../../openapi.yaml openapi.yaml
# llms.txt is web-specific (slightly different from the root version)
```

CI hook to automate this is task #149 (Block Q).
