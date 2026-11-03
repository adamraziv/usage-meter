#!/bin/sh
# Rebuilds the helper and puts it where the mod runs it: ../bin/usage-meter-helper
set -e
cd "$(dirname "$0")"
cargo build --release
mkdir -p ../bin
# Replace, never overwrite: macOS kills a signed binary rewritten in place.
rm -f ../bin/usage-meter-helper
cp target/release/usage-meter-helper ../bin/usage-meter-helper
