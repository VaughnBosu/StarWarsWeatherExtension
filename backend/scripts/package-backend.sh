#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
backend_dir=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
infra_dir="$backend_dir/infra"
requested_output=${1:-"$infra_dir/dist/star-wars-weather-backend.zip"}

case "$requested_output" in
  /*) output_path=$requested_output ;;
  *) output_path="$PWD/$requested_output" ;;
esac

mkdir -p "$(dirname -- "$output_path")"
output_dir=$(CDPATH= cd -- "$(dirname -- "$output_path")" && pwd -P)
output_path="$output_dir/$(basename -- "$output_path")"

build_dir=$(mktemp -d "${TMPDIR:-/tmp}/star-wars-weather-package.XXXXXX")
cleanup() {
  rm -rf -- "$build_dir"
}
trap cleanup EXIT

cp "$infra_dir/runtime-dependencies/package.json" "$build_dir/package.json"
cp "$infra_dir/runtime-dependencies/package-lock.json" "$build_dir/package-lock.json"
(
  cd "$build_dir"
  # Run from the package directory: with --prefix, npm derives the root package
  # name from the path and reports the lockfile as out of sync.
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)

cp "$backend_dir/index.js" "$build_dir/index.js"
cp "$backend_dir/package.json" "$build_dir/package.json"
cp -R "$backend_dir/src" "$build_dir/src"

# Normalize timestamps and zip entry metadata so identical source + lockfile inputs
# produce the same digest on repeat packaging runs.
find "$build_dir" -exec touch -t 202001010000 {} +
rm -f -- "$output_path"
(
  cd "$build_dir"
  find . -type f -print | LC_ALL=C sort | zip -X -q "$output_path" -@
)

artifact_hash=$(shasum -a 256 "$output_path" | awk '{print $1}')
artifact_bytes=$(wc -c < "$output_path" | tr -d ' ')
printf 'artifact=%s\nsha256=%s\nbytes=%s\n' "$output_path" "$artifact_hash" "$artifact_bytes"
