#!/bin/bash
# Start both MockBloom servers.
# Frontend → http://localhost:3000
# Backend API → http://localhost:3001

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Kill child processes when this script exits (Ctrl-C)
trap 'kill $(jobs -p) 2>/dev/null' EXIT

echo "Starting MockBloom backend on :3001..."
(cd "$ROOT/server" && node index.js) &

echo "Starting MockBloom frontend on :3000..."
npx --yes serve -p 3000 "$ROOT" &

wait
