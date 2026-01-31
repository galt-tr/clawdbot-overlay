#!/usr/bin/env bash
# Clawdbot BSV Overlay Skill — First-Run Setup
# Checks dependencies, connectivity, and generates an agent key if needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# Walk up to find clawdbot-overlay repo root (has node_modules/@bsv/sdk)
find_repo_root() {
  local dir="$SKILL_DIR"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -d "$dir/node_modules/@bsv/sdk" ]]; then
      echo "$dir"
      return
    fi
    dir="$(dirname "$dir")"
  done
  echo ""
}

REPO_ROOT="$(find_repo_root)"
OVERLAY_URL="${OVERLAY_URL:-http://162.243.168.235:8080}"
KEY_FILE="${REPO_ROOT:-.}/.agent-key"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  🔧 Clawdbot BSV Overlay Skill — Setup"
echo "═══════════════════════════════════════════════════════"
echo ""

# -- 1. Node.js ---------------------------------------------------------------
echo -n "  ✓ Node.js ... "
if ! command -v node &>/dev/null; then
  echo "MISSING"
  echo "    ❌ Node.js is required (>= 18). Install it first."
  exit 1
fi
echo "$(node --version)"

# -- 2. @bsv/sdk dependency ---------------------------------------------------
echo -n "  ✓ @bsv/sdk ... "
if [[ -z "$REPO_ROOT" ]]; then
  echo "NOT FOUND"
  echo "    ❌ Cannot find @bsv/sdk in node_modules."
  echo "    Run:  cd /home/dylan/clawdbot-overlay && npm install"
  exit 1
fi
SDK_VER=$(node -e "console.log(require('$REPO_ROOT/node_modules/@bsv/sdk/package.json').version)" 2>/dev/null || echo "unknown")
echo "$SDK_VER  (at $REPO_ROOT/node_modules/@bsv/sdk)"

# -- 3. Agent key --------------------------------------------------------------
echo -n "  ✓ Agent key ... "
if [[ -n "${AGENT_PRIVATE_KEY:-}" ]]; then
  echo "set via AGENT_PRIVATE_KEY env"
elif [[ -f "$KEY_FILE" ]]; then
  echo "found at $KEY_FILE"
else
  echo "generating..."
  node -e "
    const { PrivateKey } = require('$REPO_ROOT/node_modules/@bsv/sdk/dist/cjs/src/index.js');
    const k = PrivateKey.fromRandom();
    require('fs').writeFileSync('$KEY_FILE', k.toHex());
    console.log('    🔑 New key saved to $KEY_FILE');
    console.log('    📋 Identity: ' + k.toPublicKey().toDER('hex'));
  "
fi

# -- 4. Overlay connectivity ---------------------------------------------------
echo -n "  ✓ Overlay server ($OVERLAY_URL) ... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$OVERLAY_URL/" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "000" ]]; then
  echo "UNREACHABLE"
  echo "    ⚠  Cannot reach overlay. Commands will fail until server is available."
else
  echo "OK (HTTP $HTTP_CODE)"
fi

# -- 5. Test discover command ---------------------------------------------------
echo -n "  ✓ CLI smoke test ... "
CLI="$SCRIPT_DIR/overlay-cli.mjs"
RESULT=$(node "$CLI" discover agents 2>&1 || true)
if echo "$RESULT" | grep -q '"success"'; then
  echo "OK"
else
  echo "WARN"
  echo "    ⚠  CLI returned unexpected output. Check errors above."
fi

# -- Done ----------------------------------------------------------------------
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Setup complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  CLI:  node $CLI"
echo ""
echo "  Quick commands:"
echo "    node $CLI discover agents"
echo "    node $CLI discover services"
echo "    node $CLI register identity --name \"my-bot\" --description \"A helpful bot\" --capabilities \"research,jokes\""
echo "    node $CLI register service --id \"do-stuff\" --name \"Do Stuff\" --description \"Does stuff\" --price 10"
echo ""
