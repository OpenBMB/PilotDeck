#!/bin/sh
set -eu
MINT_SOURCE=${MINT_SOURCE:-/Users/a1/Documents/ChatGPT/mint-pilotdeck-integration}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/tmp/mint-merge-all-mrs-20261104/target}
cd "$MINT_SOURCE"
cargo build -p mint-core --features js-host --example installed_loop_worker --example installed_tool_command
cargo build -p mint-core-bin --features js-host --bin cpmrt
cargo build -p mint-host --bin mint-host
cargo build -p agentcpm-host --example installed-owner-kernel
