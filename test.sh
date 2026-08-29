#!/usr/bin/env bash

# Build, deploy, or clear Tephramesh in the testing vault.
# Override the destination for another vault with:
# TEPHRAMESH_TEST_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/tephramesh" ./test.sh build

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
ICLOUD_PLUGIN_DIR="/Users/willjasen/Library/Mobile Documents/iCloud~md~obsidian/Documents/testing/.obsidian/plugins/tephramesh"
PLUGIN_DIRS=()
if [[ -n "${TEPHRAMESH_TEST_PLUGIN_DIR:-}" ]]; then
  PLUGIN_DIRS+=("${TEPHRAMESH_TEST_PLUGIN_DIR%/}")
else
  PLUGIN_DIRS=("$DEFAULT_PLUGIN_DIR" "$ICLOUD_PLUGIN_DIR")
fi
VAULT_NAMES=("Notebox" "testing")
OBSIDIAN_CLI="${OBSIDIAN_CLI:-/Applications/Obsidian.app/Contents/MacOS/obsidian-cli}"
FILES=("main.js" "manifest.json" "styles.css")

usage() {
  echo "Usage: ./test.sh <build|clear>"
  echo
  echo "  build  Install dependencies, build Tephramesh, and copy it to the testing vault."
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
  npm ci --silent
  npm run build

  for plugin_dir in "${PLUGIN_DIRS[@]}"; do
    PLUGIN_DIR="$plugin_dir"
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
  done

  success "Tephramesh was copied to: ${PLUGIN_DIRS[*]}"
  if [[ ! -x "$OBSIDIAN_CLI" ]]; then
    error "Obsidian CLI was not found or is not executable: $OBSIDIAN_CLI"
    exit 1
  fi
  for vault_name in "${VAULT_NAMES[@]}"; do
    step "Reloading Tephramesh in the $vault_name vault..."
    "$OBSIDIAN_CLI" "vault=$vault_name" plugin:disable id=tephramesh filter=community
    "$OBSIDIAN_CLI" "vault=$vault_name" plugin:enable id=tephramesh filter=community
    success "Tephramesh was disabled and re-enabled in the $vault_name vault."
  done
}

clear_config() {
  PLUGIN_DIR="${PLUGIN_DIRS[0]}"
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
