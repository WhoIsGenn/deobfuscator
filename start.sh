#!/usr/bin/env bash
# start.sh - Run this in your GitHub Codespace to set up and start the bot.
# Usage: bash start.sh
set -e

echo "[*] Installing Node dependencies..."
npm install

echo "[*] Making luau binary executable..."
chmod +x bin/luau bin/luau-ast 2>/dev/null || true

# Check env vars
if [ -z "$DISCORD_TOKEN" ] || [ -z "$CLIENT_ID" ]; then
  echo ""
  echo "⚠️  Missing environment variables!"
  echo "    Set them in Codespaces → Settings → Secrets (or export here):"
  echo "    export DISCORD_TOKEN=your_token_here"
  echo "    export CLIENT_ID=your_client_id_here"
  echo "    export GUILD_ID=your_guild_id_here  # optional but recommended"
  echo ""
  read -p "Continue anyway? (y/N) " yn
  if [[ "$yn" != "y" && "$yn" != "Y" ]]; then exit 1; fi
fi

echo "[*] Registering slash commands..."
node bot.js --register

echo "[*] Starting bot..."
node bot.js
