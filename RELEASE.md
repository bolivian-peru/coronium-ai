# Releasing coronium-sdk and coronium-cli

Publishing is done by a maintainer. Nothing in this repository publishes on push, and an agent does not publish without the owner's explicit go-ahead.

## 1. Pre-flight

```bash
git checkout main && git pull
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm run doctor
pnpm publish:dry          # inspect both tarballs: only dist/, README.md, LICENSE, package.json
```

Check that `packages/sdk-ts/package.json` and `packages/cli/package.json` carry the same version as `SDK_VERSION` (`packages/sdk-ts/src/version.ts`) and `CLI_VERSION` (`packages/cli/src/version.ts`).

## 2. Publish (SDK first, then CLI)

Use `pnpm publish`, not `npm publish`: pnpm rewrites the CLI's `coronium-sdk: workspace:*` dependency to the exact SDK version. `npm publish` would ship the literal `workspace:*` and break installs.

```bash
pnpm --filter coronium-sdk publish --access public
npm view coronium-sdk@1.0.0 version        # must print 1.0.0 before continuing

pnpm --filter coronium-cli publish --access public
npm view coronium-cli@1.0.0 version
npm view coronium-cli@1.0.0 dependencies   # coronium-sdk must be 1.0.0, not workspace:*
```

## 3. Deprecations (prepared, not run)

Run these only after step 2 succeeded and both `npm view` checks printed the new versions. Each command needs a maintainer login with 2FA.

Published today: `0.1.0-alpha.0` to `0.1.0-alpha.4`, `0.2.0-beta.1` and `0.2.0` for each of the three packages. A range like `<=0.2.0` may not match pre-release versions, so the commands below name the package as a whole (coronium-mcp has no newer version) or list the pre-releases explicitly.

```bash
# The MCP server from this repo (every version, all <= 0.2.0): replaced by coronium-proxy-mcp.
npm deprecate coronium-mcp "coronium-mcp is retired. It targeted API routes that never existed on api.coronium.io and can return false results. Use coronium-proxy-mcp: npx -y coronium-proxy-mcp"

# SDK and CLI 0.x: replaced by 1.0.0. Run once per listed version.
SDK_MSG="coronium-sdk 0.x calls routes that do not exist on api.coronium.io/api/v3 and can return an HTML page as data. Upgrade to coronium-sdk@^1.0.0."
CLI_MSG="coronium-cli 0.x commands other than init and key:rotate do not work against api.coronium.io and can print false successes. Upgrade to coronium-cli@^1.0.0."
for v in 0.2.0 0.2.0-beta.1 0.1.0-alpha.4 0.1.0-alpha.3 0.1.0-alpha.2 0.1.0-alpha.1 0.1.0-alpha.0; do
  npm deprecate "coronium-sdk@$v" "$SDK_MSG"
  npm deprecate "coronium-cli@$v" "$CLI_MSG"
done
```

Never deprecate `coronium-sdk` or `coronium-cli` without a version: that would also flag 1.0.0.

Verify:

```bash
npm view coronium-mcp@0.2.0 deprecated
npm view coronium-sdk@0.2.0 deprecated
npm view coronium-cli@0.1.0-alpha.0 deprecated
npm view coronium-sdk@1.0.0 deprecated      # must print nothing
```

To undo a deprecation, run the same command with an empty message, for example `npm deprecate coronium-mcp ""`.

## 4. After publishing

- Tag the release: `git tag sdk-v1.0.0 && git tag cli-v1.0.0 && git push --tags`.
- Update any public pages that still point at `coronium-mcp` so they point at `coronium-proxy-mcp`.
