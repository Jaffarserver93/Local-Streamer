#!/bin/bash
echo "🚀 Fixing & Updating Local-Streamer on Termux..."
git reset --hard origin/main
git pull origin main
cd artifacts/api-server
node ./dist/index.mjs
