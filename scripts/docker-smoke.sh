#!/usr/bin/env bash
# Smoke test for the container image (Dockerfile). CI runs it on pull requests.
#
#   scripts/docker-smoke.sh                    build apitame:smoke-<pid> from this checkout, test it, remove it
#   IMAGE=apitame:ci scripts/docker-smoke.sh   test an image that is already built (it is kept)
#
# Checks that the image refuses to start without authentication, then runs it the way
# docs/deploy.md recommends (read-only root filesystem, tmpfs /tmp, no capabilities, non-root) with
# a token and examples/petstore: /health, the token check, MCP tools/list and tools/call (no
# network needed), the Docker health status, logs without the token, and a clean stop.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-}"
PORT="${PORT:-18080}"
NAME="apitame-smoke-$$"
TOKEN="fake-key-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
CONFIG="$ROOT/examples/petstore"
BUILT=""

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ -n "$BUILT" ]; then docker image rm -f "$BUILT" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs "$NAME" 2>&1 | tail -20 >&2 || true
  exit 1
}

if [ -z "$IMAGE" ]; then
  IMAGE="apitame:smoke-$$"
  BUILT="$IMAGE"
  docker build -t "$IMAGE" "$ROOT"
fi

echo "1. refuses to start without APITAME_HTTP_TOKEN or http.oauth"
if out="$(docker run --rm -v "$CONFIG:/config:ro" "$IMAGE" 2>&1)"; then
  fail "the container started without authentication"
fi
grep -q "Refusing to listen on 0.0.0.0 without authentication" <<<"$out" || fail "unexpected output: $out"

echo "2. starts read-only, without capabilities, as a non-root user"
[ "$(docker image inspect -f '{{.Config.User}}' "$IMAGE")" = "10001:10001" ] || fail "the image user is not 10001:10001"
docker run -d --name "$NAME" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e APITAME_HTTP_TOKEN="$TOKEN" \
  -v "$CONFIG:/config:ro" \
  -p "127.0.0.1:$PORT:8080" \
  "$IMAGE" >/dev/null
[ "$(docker exec "$NAME" id -u)" = "10001" ] || fail "the server does not run as UID 10001"

echo "3. GET /health"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && fail "/health did not answer within 30 seconds"
  sleep 0.5
done
body="$(curl -fsS "http://127.0.0.1:$PORT/health")"
[ "$body" = '{"ok":true}' ] || fail "/health answered $body"

echo "4. /mcp requires the token"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
[ "$code" = 401 ] || fail "/mcp without the token answered HTTP $code"

echo "5. MCP tools/list and tools/call with the token"
rpc() {
  curl -fsS "http://127.0.0.1:$PORT/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-11-25' \
    -d "$1"
}
list="$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
grep -q '"name":"search_operations"' <<<"$list" || fail "tools/list answered: $list"
call="$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_operations","arguments":{"query":"inventory"}}}')"
grep -q 'getInventory' <<<"$call" || fail "tools/call answered: $call"

echo "6. Docker reports the container healthy"
for i in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$NAME")"
  [ "$status" = healthy ] && break
  [ "$i" = 30 ] && fail "health status is $status after 30 seconds"
  sleep 1
done

echo "7. the logs do not contain the token"
if docker logs "$NAME" 2>&1 | grep -qF "$TOKEN"; then fail "the token appears in the logs"; fi

echo "8. stops cleanly on SIGTERM"
docker stop -t 10 "$NAME" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" = 0 ] || fail "exit code $(docker inspect -f '{{.State.ExitCode}}' "$NAME")"

echo "OK: $IMAGE passed the smoke test"
