#!/usr/bin/env bash

# Build, deploy, or clear Tephramesh in the testing vault.
# Override the destination for another vault with:
# TEPHRAMESH_TEST_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/tephramesh" ./test.sh build

set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${TEPHRAMESH_TEST_PLUGIN_DIR:-/Users/willjasen/AppData/Syncthing/Notebox/.obsidian/plugins/tephramesh}"
PLUGIN_DIR="${PLUGIN_DIR%/}"
FILES=("main.js" "manifest.json" "styles.css")

usage() {
  echo "Usage: ./test.sh <build|clear>"
  echo
  echo "  build  Install dependencies, build Tephramesh, and copy it to the testing vault."
  echo "  clear  Remove Tephramesh's data.json, then build and redeploy the plugin."
}

validate_plugin_dir() {
  if [[ "$PLUGIN_DIR" != */.obsidian/plugins/tephramesh ]]; then
    echo "Refusing to use an unexpected plugin directory: $PLUGIN_DIR" >&2
    echo "The path must end with /.obsidian/plugins/tephramesh" >&2
    exit 1
  fi
}

build_plugin() {
  validate_plugin_dir
  if [[ -d "$PLUGIN_DIR" ]]; then
    echo "Plugin directory already exists: $PLUGIN_DIR"
  else
    echo "Creating plugin directory: $PLUGIN_DIR"
    mkdir -p "$PLUGIN_DIR"
  fi

  echo "Installing dependencies and building Tephramesh..."
  cd "$SOURCE_DIR"
  npm ci --silent
  npm run build

  for file in "${FILES[@]}"; do
    if [[ ! -f "$SOURCE_DIR/$file" ]]; then
      echo "Build output is missing: $SOURCE_DIR/$file" >&2
      exit 1
    fi
    echo "Copying $file"
    cp "$SOURCE_DIR/$file" "$PLUGIN_DIR/$file"
  done

  echo "Tephramesh was copied to: $PLUGIN_DIR"
  echo "Reload Obsidian, or disable and re-enable Tephramesh, to load the new build."
}

clear_config() {
  validate_plugin_dir
  local config_file="$PLUGIN_DIR/data.json"
  if [[ ! -f "$config_file" ]]; then
    echo "No Tephramesh configuration exists at: $config_file"
    return
  fi

  rm -f -- "$config_file"
  echo "Removed Tephramesh configuration: $config_file"
  echo "Reload Obsidian, or disable and re-enable Tephramesh, before setting it up again."
  echo "Obsidian Keychain entries are not removed and can be managed in Obsidian settings."
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
