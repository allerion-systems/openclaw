#!/usr/bin/env bash
# Allerion installer — installs the Allerion build of OpenClaw from source.
# Usage: curl -fsSL <site>/install.sh | bash
#        curl -fsSL <site>/install.sh | bash -s -- --dry-run
set -euo pipefail

REPO_URL="${ALLERION_REPO:-https://github.com/allerion-systems/openclaw.git}"
BRANCH="${ALLERION_BRANCH:-main}"
ALLERION_HOME="${ALLERION_HOME:-$HOME/.allerion}"
SRC_DIR="$ALLERION_HOME/openclaw"
BIN_DIR="${ALLERION_BIN:-$HOME/.local/bin}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help)
      echo "Allerion installer. Env overrides: ALLERION_REPO, ALLERION_BRANCH, ALLERION_HOME, ALLERION_BIN. Flags: --dry-run"
      exit 0
      ;;
  esac
done

say() { printf '\033[1;36m[allerion]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[allerion]\033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then say "dry-run: $*"; else "$@"; fi; }

command -v git >/dev/null 2>&1 || die "git is required. Install git and re-run."
command -v node >/dev/null 2>&1 || die "Node.js 22.19+ is required. Install from https://nodejs.org and re-run."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22.19+ required (found $(node -v))."

# pnpm via corepack (ships with Node) so we do not touch global npm state.
if ! command -v pnpm >/dev/null 2>&1; then
  say "enabling pnpm via corepack"
  run corepack enable pnpm || die "could not enable pnpm via corepack; install pnpm manually."
fi

if [ -d "$SRC_DIR/.git" ]; then
  say "updating existing checkout in $SRC_DIR"
  run git -C "$SRC_DIR" fetch origin "$BRANCH"
  run git -C "$SRC_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  say "cloning $REPO_URL ($BRANCH) into $SRC_DIR"
  run mkdir -p "$ALLERION_HOME"
  run git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi

say "installing dependencies (this can take a few minutes)"
run bash -c "cd '$SRC_DIR' && pnpm install --prod=false"
say "building"
run bash -c "cd '$SRC_DIR' && pnpm build"

say "linking CLI into $BIN_DIR/openclaw"
run mkdir -p "$BIN_DIR"
if [ "$DRY_RUN" = 0 ]; then
  cat > "$BIN_DIR/openclaw" <<WRAPPER
#!/usr/bin/env bash
exec node "$SRC_DIR/openclaw.mjs" "\$@"
WRAPPER
  chmod +x "$BIN_DIR/openclaw"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: add $BIN_DIR to your PATH to use 'openclaw' directly." ;;
esac

say "done. Next: run 'openclaw onboard' to set up your assistant."
say "Allerion is built on OpenClaw (MIT). License: $SRC_DIR/LICENSE"
