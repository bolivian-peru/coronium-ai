#!/usr/bin/env bash
# The one check for this repository. CI runs exactly this, and it must pass
# before every commit. It fails, and never skips, when something it needs is
# missing.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "check failed: $1" >&2
  echo "fix: $2" >&2
  exit 1
}

command -v cargo >/dev/null || fail "cargo is not on PATH" "install Rust with rustup"
command -v go >/dev/null || fail "go is not on PATH" "install Go, or add its bin directory to PATH"
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set" \
  "start a Postgres (see README.md, Running the check) and export DATABASE_URL"

echo "== secrets"
# Secret-shaped strings must never reach the repository.
SECRETS='-----BEGIN [A-Z ]*PRIVATE KEY-----|sk_live_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
if git grep --untracked -nIE -e "$SECRETS" -- . ':!scripts/check.sh'; then
  fail "a secret-shaped string is in the tree" "remove it and rotate the secret"
fi

echo "== rust"
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

echo "== go"
(
  cd agent
  unformatted="$(gofmt -l .)"
  [ -z "$unformatted" ] || fail "gofmt would change: $unformatted" "run gofmt -w agent"
  go vet ./...
  go test ./...
  # The agent has to run on routers.
  GOOS=linux GOARCH=mipsle go build ./...
  GOOS=linux GOARCH=mips go build ./...
)

echo "check: ok"
