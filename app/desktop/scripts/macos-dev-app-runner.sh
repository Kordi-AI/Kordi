#!/usr/bin/env bash
# Cargo runner for macOS desktop previews. It starts the debug binary from a
# minimal ad-hoc signed .app so macOS privacy prompts, such as Location
# Services, can identify the app. A bare binary never gets a location prompt.
#
# The app is also started as its own privacy (TCC) responsible process through
# macos-disclaim-exec.c. Otherwise macOS holds the launching editor, terminal
# or agent responsible: Calendar and Location prompts never appear for it and
# their status stays "not determined". The helper keeps exec semantics (same
# pid, working directory, environment, output and signals), so Tauri dev can
# still stream logs and restart the app.
set -uo pipefail

if [[ $# -eq 0 ]]; then
  echo "[kordi] Missing binary for the macOS dev app runner." >&2
  exit 2
fi

binary="$1"
shift

identifier="${KORDI_DEV_BUNDLE_IDENTIFIER:-}"
if [[ "$(uname -s)" != "Darwin" || -z "$identifier" || "$(basename "$binary")" != "kordi-desktop" ]]; then
  exec "$binary" "$@"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
info_template="$script_dir/../src-tauri/Info.plist"
name="${KORDI_DEV_BUNDLE_NAME:-Kordi}"
name="${name//\//-}"
bin_dir="$(cd "$(dirname "$binary")" && pwd)"
exe="$(basename "$binary")"
app="$bin_dir/dev-app-bundles/$identifier/$name.app"

build_bundle() {
  rm -rf "$bin_dir/dev-app-bundles/$identifier" || return 1
  mkdir -p "$app/Contents/MacOS" || return 1
  # Clone on APFS; signing then rewrites only this copy.
  cp -c "$bin_dir/$exe" "$app/Contents/MacOS/$exe" 2>/dev/null \
    || cp "$bin_dir/$exe" "$app/Contents/MacOS/$exe" || return 1
  # Sidecars are found next to the executable; resources stay in the target directory.
  local entry
  for entry in "$bin_dir"/*; do
    [[ -f "$entry" && "$entry" != "$bin_dir/$exe" ]] || continue
    [[ -x "$entry" || "$entry" == *.node ]] || continue
    ln -s "$entry" "$app/Contents/MacOS/$(basename "$entry")" || return 1
  done
  ln -s "$bin_dir" "$app/Contents/Resources" || return 1
  local plist="$app/Contents/Info.plist"
  cp "$info_template" "$plist" || return 1
  plutil -replace CFBundleIdentifier -string "$identifier" "$plist" || return 1
  plutil -replace CFBundleName -string "$name" "$plist" || return 1
  plutil -replace CFBundleDisplayName -string "$name" "$plist" || return 1
  plutil -replace CFBundleExecutable -string "$exe" "$plist" || return 1
  plutil -replace CFBundlePackageType -string APPL "$plist" || return 1
  plutil -replace NSHighResolutionCapable -bool YES "$plist" || return 1
  # The signature binds Info.plist; without it macOS treats the app as a bare binary.
  codesign --force --sign - --identifier "$identifier" "$app" >/dev/null 2>&1 || return 1
}

# Compiles the disclaim helper once per source change. Prints its path, or
# fails when no C compiler is available.
disclaim_helper() {
  local source="$script_dir/macos-disclaim-exec.c"
  local dir="$bin_dir/dev-app-bundles/.launcher"
  local helper="$dir/macos-disclaim-exec"
  [[ -f "$source" ]] || return 1
  if [[ ! -x "$helper" ]] || ! cmp -s "$source" "$dir/macos-disclaim-exec.c"; then
    mkdir -p "$dir" || return 1
    # Previews of several profiles can share this target directory; build
    # aside and rename so a concurrent launch never runs a partial file.
    local tmp="$helper.$$"
    if ! { xcrun --sdk macosx clang -O2 -o "$tmp" "$source" >/dev/null 2>&1 \
      || cc -O2 -o "$tmp" "$source" >/dev/null 2>&1; }; then
      rm -f "$tmp"
      return 1
    fi
    mv -f "$tmp" "$helper" || return 1
    cp "$source" "$dir/macos-disclaim-exec.c.$$" && mv -f "$dir/macos-disclaim-exec.c.$$" "$dir/macos-disclaim-exec.c"
  fi
  printf '%s\n' "$helper"
}

if build_bundle; then
  # KORDI_DEV_APP_DISCLAIM=0 keeps the launching tool responsible, as before.
  if [[ "${KORDI_DEV_APP_DISCLAIM:-1}" != "0" ]]; then
    if helper="$(disclaim_helper)"; then
      exec "$helper" "$app/Contents/MacOS/$exe" "$@"
    fi
    echo "[kordi] Could not prepare the macOS launch helper; Calendar and Location prompts appear only when the launching app may show them." >&2
  fi
  exec "$app/Contents/MacOS/$exe" "$@"
fi
echo "[kordi] Could not prepare the macOS dev app bundle; starting the bare binary. Location prompts will not appear." >&2
exec "$binary" "$@"
