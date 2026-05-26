#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required."
  echo "Install it from https://nodejs.org/ and run this script again."
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required. Current version: $(node -v)"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required, but it was not found in PATH."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Building app..."
npm run build

echo "Starting Cherry Canvas Pro..."
echo "Open http://127.0.0.1:5174/ in your browser."

if command -v open >/dev/null 2>&1; then
  (sleep 2 && open "http://127.0.0.1:5174/") >/dev/null 2>&1 &
fi

npm start
