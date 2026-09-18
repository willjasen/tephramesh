#!/usr/bin/env bash

# Build, deploy, or clear Tephramesh in the Notebox vault.

set -euo pipefail

if [[ -t 1 && -z "${NO_COLOR:-}" ]] || [[ -n "${FORCE_COLOR:-}" ]]; then
  RED=$'\033[31m'
  YELLOW=$'\033[33m'
  GREEN=$'\033[32m'
  BLUE=$'\033[34m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED=''
  YELLOW=''
  GREEN=''
  BLUE=''
  BOLD=''
  RESET=''
fi

info() { printf '%s%s%s\n' "$BLUE" "$*" "$RESET"; }
success() { printf '%s%s%s\n' "$GREEN" "$*" "$RESET"; }
warning() { printf '%s%s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
error() { printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2; }
step() { printf '%s%s%s\n' "$BOLD" "$*" "$RESET"; }

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PLUGIN_DIR="/Users/willjasen/AppData/Syncthing/Notebox/.obsidian/plugins/tephramesh"
PLUGIN_DIR="$DEFAULT_PLUGIN_DIR"
VAULT_NAME="Notebox"
OBSIDIAN_CLI="${OBSIDIAN_CLI:-/Applications/Obsidian.app/Contents/MacOS/obsidian-cli}"
FILES=("main.js" "manifest.json" "styles.css")

usage() {
  echo "Usage: ./test.sh <build|clear>"
  echo
  echo "  build  Install dependencies, build Tephramesh, and copy it to Notebox."
  echo "  clear  Remove Tephramesh's data.json, then build and redeploy the plugin."
}

validate_plugin_dir() {
  if [[ "$PLUGIN_DIR" != */.obsidian/plugins/tephramesh ]]; then
    error "Refusing to use an unexpected plugin directory: $PLUGIN_DIR"
    error "The path must end with /.obsidian/plugins/tephramesh"
    exit 1
  fi
}

build_plugin() {
  step "Installing dependencies and building Tephramesh..."
  cd "$SOURCE_DIR"
  if command -v npm >/dev/null 2>&1; then
    npm ci --silent
    npm run build
  else
    # Codex's bundled runtime provides Node and pnpm, but not a standalone
    # npm executable. Keep the test/deploy helper usable in that environment
    # without creating or changing a pnpm lockfile.
    if ! command -v pnpm >/dev/null 2>&1; then
      error "Neither npm nor pnpm is available. Install Node.js/npm or pnpm."
      exit 1
    fi
    # The bundled pnpm launcher is adjacent to its Node runtime, but child
    # scripts (tsc/esbuild) still resolve `node` through PATH.
    PNPM_BIN="$(command -v pnpm)"
    BUNDLED_NODE_BIN="$(cd -- "$(dirname -- "$PNPM_BIN")/../../node/bin" && pwd)"
    export PATH="$BUNDLED_NODE_BIN:$PATH"
    pnpm install --lockfile=false --silent
    pnpm run build
  fi

  validate_plugin_dir
  if [[ -d "$PLUGIN_DIR" ]]; then
    info "Plugin directory already exists: $PLUGIN_DIR"
  else
    info "Creating plugin directory: $PLUGIN_DIR"
    mkdir -p "$PLUGIN_DIR"
  fi

  for file in "${FILES[@]}"; do
    if [[ ! -f "$SOURCE_DIR/$file" ]]; then
      error "Build output is missing: $SOURCE_DIR/$file"
      exit 1
    fi
    info "Copying $file to $PLUGIN_DIR"
    cp "$SOURCE_DIR/$file" "$PLUGIN_DIR/$file"
  done

  success "Tephramesh was copied to: $PLUGIN_DIR"
  if [[ ! -x "$OBSIDIAN_CLI" ]]; then
    error "Obsidian CLI was not found or is not executable: $OBSIDIAN_CLI"
    exit 1
  fi
  step "Reloading Tephramesh in the $VAULT_NAME vault..."
  "$OBSIDIAN_CLI" "vault=$VAULT_NAME" plugin:disable id=tephramesh filter=community
  "$OBSIDIAN_CLI" "vault=$VAULT_NAME" plugin:enable id=tephramesh filter=community
  success "Tephramesh was disabled and re-enabled in the $VAULT_NAME vault."
}

clear_config() {
  validate_plugin_dir
  local config_file="$PLUGIN_DIR/data.json"
  if [[ ! -f "$config_file" ]]; then
    warning "No Tephramesh configuration exists at: $config_file"
    return
  fi

  rm -f -- "$config_file"
  success "Removed Tephramesh configuration: $config_file"
  info "Reload Obsidian, or disable and re-enable Tephramesh, before setting it up again."
  info "Obsidian Keychain entries are not removed and can be managed in Obsidian settings."
}

case "${1:-}" in
  build)
    build_plugin
    ;;
  clear)
    clear_config
    build_plugin
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
