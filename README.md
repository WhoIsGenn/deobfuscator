# Multi-Obfuscator Deobfuscator — Discord Bot

Deobfuscates Roblox Luau scripts from multiple obfuscators using a real sandboxed execution engine.

## Supported Obfuscators

| Obfuscator     | Method                              | Output quality |
|---------------|--------------------------------------|----------------|
| **Luraph v15** | Full devirtualization + CFG rebuild | ⭐⭐⭐⭐⭐ Clean readable Luau |
| **WeAreDevs**  | Sandbox layer-peel + string decrypt | ⭐⭐⭐⭐ Real code if string-table based |
| **MoonSec v2/v3** | Sandbox layer-peel + base-N decode | ⭐⭐⭐⭐ Real code extracted |
| **IronBrew 2** | Sandbox trace + layer peel          | ⭐⭐⭐ Behaviour trace + decrypted strings |
| **Prometheus** | Sandbox trace + layer peel          | ⭐⭐⭐ Behaviour trace + decrypted strings |
| **Unknown VM** | Sandbox behaviour trace             | ⭐⭐ Shows every API call + decrypted strings |

## Commands

| Command | Description |
|---------|-------------|
| `/deobfuscate` | Upload a `.lua` file and deobfuscate it |
| `/detect` | Detect which obfuscator was used |
| `.l <url>` | Fetch & deobfuscate from a URL (Pastebin, Pastefy, GitHub, direct links) |
| `/help` | Show help |

## Quick Start (GitHub Codespaces)

1. **Fork / push this repo to GitHub**

2. **Open in Codespaces** (green Code button → Codespaces → Create)

3. **Set secrets** in your repo: Settings → Secrets → Actions:
   - `DISCORD_TOKEN` — your bot token
   - `CLIENT_ID` — your bot's application ID
   - `GUILD_ID` — your server ID (optional but speeds up slash command registration)

4. **Run in Codespace terminal:**
   ```bash
   bash start.sh
   ```
   Or run directly:
   ```bash
   npm install
   chmod +x bin/luau bin/luau-ast
   node bot.js --register   # registers slash commands once
   node bot.js              # starts the bot
   ```

5. **Via GitHub Actions** (runs for 6h on GitHub's servers):
   - Go to Actions tab → "Setup & Run Bot" → Run workflow

## How It Works

### Luraph v15 (full devirtualization)
The script's VM is instrumented at every closure entry point.
It runs inside a sandboxed fake Roblox environment (`runtime/envlog.luau`)
that intercepts every API call. Then the captured function prototypes are
lifted through SCCP (sparse conditional constant propagation) with live
constant decryption from the running harness.

### WeAreDevs / MoonSec / IronBrew2 (layer peeling)
Most string-table + loadstring obfuscators work in layers:
1. The outer script decrypts a string (XOR, base64, etc.)
2. It calls `loadstring(decrypted_string)` to run the real code
3. We catch that `loadstring` argument — that's the real script

The sandbox catches up to 4 layers of this. If the payload is itself
obfuscated, we peel again. The result is the actual script code.

### Unknown VMs
If the obfuscator runs its own VM (like Luraph but unrecognized), we can't
reconstruct the original code without a dedicated devirtualizer. Instead we
output a behaviour trace: every Roblox API call, every decrypted string, and
every observable operation the script performed. This is still far more useful
than the obfuscated source.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | ✅ | Bot token from Discord Developer Portal |
| `CLIENT_ID` | ✅ | Application ID from Developer Portal |
| `GUILD_ID` | ⬜ Optional | Server ID for instant slash command registration |

## Notes

- The `bin/luau` and `bin/luau-ast` binaries must be executable (`chmod +x`)
- The bot needs **Message Content Intent** enabled in Discord Developer Portal
  (Bot settings → Privileged Gateway Intents → Message Content Intent)
- For GitHub Actions: the bot runs for max 6 hours per run (GitHub free tier limit)
