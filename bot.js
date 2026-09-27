'use strict';
const { Client, GatewayIntentBits, REST, Routes,
        SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('ERROR: DISCORD_TOKEN and CLIENT_ID must be set.');
  process.exit(1);
}

const DEOB  = path.resolve(__dirname, 'deob.js');
const TOMS  = 3 * 60 * 1000;
const MAXMB = 5;

// Obfuscator labels for embed display
const OB_LABELS = {
  luraph_v15: '🔒 Luraph v15',
  wearedevs:  '🔓 WeAreDevs',
  moonsec:    '🔓 MoonSec',
  ironbrew2:  '🔓 IronBrew 2',
  prometheus: '🔓 Prometheus',
  generic_vm: '🔓 Unknown VM',
  generic:    '❓ Unknown obfuscator',
};

const cmds = [
  new SlashCommandBuilder()
    .setName('deobfuscate')
    .setDescription('Deobfuscate a Roblox script (Luraph v15, WeAreDevs, MoonSec, IronBrew2, more)')
    .addAttachmentOption(o => o.setName('script').setDescription('.lua or .luau file').setRequired(true))
    .addBooleanOption(o => o.setName('no_devirt').setDescription('Fast trace mode (~2s, Luraph only)').setRequired(false))
    .addIntegerOption(o => o.setName('timeout').setDescription('Timeout in seconds (10-180)').setRequired(false).setMinValue(10).setMaxValue(180))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('detect')
    .setDescription('Detect which obfuscator was used, without deobfuscating')
    .addAttachmentOption(o => o.setName('script').setDescription('.lua or .luau file').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show bot usage and supported obfuscators')
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  console.log('[*] Registering slash commands...');
  await rest.put(route, { body: cmds });
  console.log('[+] Done.');
  process.exit(0);
}

if (process.argv.includes('--register')) {
  registerCommands().catch(e => { console.error(e); process.exit(1); });
}

// ─── URL fetching (follows redirects) ────────────────────────────────────────
function fetchUrl(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    lib.get(rawUrl, { headers: { 'User-Agent': 'luraph-deob-bot/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Smart URL → raw resolver ─────────────────────────────────────────────────
function resolveRawUrl(inputUrl) {
  let u;
  try { u = new URL(inputUrl.trim()); } catch { return inputUrl.trim(); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const p    = u.pathname;

  if (host === 'github.com')
    return 'https://raw.githubusercontent.com/' + p.replace(/^\//, '').replace(/\/blob\//, '/');
  if (host === 'raw.githubusercontent.com') return inputUrl.trim();

  if (host === 'pastebin.com') {
    if (!p.startsWith('/raw/')) {
      const id = p.split('/').filter(Boolean).pop();
      return 'https://pastebin.com/raw/' + id;
    }
    return inputUrl.trim();
  }

  if (host === 'pastefy.app') {
    const parts = p.split('/').filter(Boolean);
    if (parts.length === 1) return 'https://pastefy.app/' + parts[0] + '/raw';
    return inputUrl.trim();
  }

  return inputUrl.trim(); // direct raw link (cloverhub.app etc.)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function dlFile(url, dest) {
  return new Promise((res, rej) => {
    const f = fs.createWriteStream(dest);
    https.get(url, r => {
      if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode));
      r.pipe(f);
      f.on('finish', () => f.close(res));
    }).on('error', e => { fs.unlink(dest, () => {}); rej(e); });
  });
}

function runDeob(args, ms) {
  return new Promise((res, rej) => {
    execFile('node', [DEOB, ...args], { timeout: ms, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed)     return rej(new Error('Timed out.'));
        if (err && err.code !== 0) return rej(new Error(stderr || err.message));
        res({ stdout: stdout || '', stderr: stderr || '' });
      });
  });
}

function fmt(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
}

function errEmbed(t, d) {
  return new EmbedBuilder().setColor(0xE74C3C).setTitle('❌ ' + t).setDescription(d).setTimestamp();
}
function okEmbed(t, d) {
  return new EmbedBuilder().setColor(0x2ECC71).setTitle('✅ ' + t).setDescription(d).setTimestamp();
}

function validate(att) {
  const n = att.name || '';
  if (!n.endsWith('.lua') && !n.endsWith('.luau')) return 'File must be .lua or .luau';
  if (att.size / 1024 / 1024 > MAXMB) return 'File too large (max ' + MAXMB + ' MB)';
  return null;
}

// Parse stderr from deob.js to find detected obfuscator label
function parseObfuscator(stderr) {
  const m = /obfuscator: (.+?) \(/.exec(stderr);
  return m ? m[1].trim() : null;
}

// ─── .l <url> prefix handler ─────────────────────────────────────────────────
async function handleLinkCommand(message) {
  const rawInput = message.content.slice(3).trim();
  if (!rawInput) {
    return message.reply({ embeds: [errEmbed('Usage', '`.l <url>` — provide a script URL.\nSupports: GitHub, Pastebin, Pastefy, or any direct raw link.')] });
  }

  const rawUrl = resolveRawUrl(rawInput);
  const status = await message.reply({ embeds: [
    new EmbedBuilder()
      .setColor(0x3498DB).setTitle('🔗 Fetching script…')
      .setDescription('`' + rawUrl + '`').setTimestamp()
  ]});

  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'luraph-'));
  const inp  = path.join(tmp, 'script.lua');
  const outp = path.join(tmp, 'deob_script.lua');
  const t0   = Date.now();

  try {
    let source;
    try {
      source = await fetchUrl(rawUrl);
    } catch (fetchErr) {
      return status.edit({ embeds: [errEmbed('Fetch failed', '`' + rawUrl + '`\n```\n' + fetchErr.message + '\n```')] });
    }

    if (!source || !source.trim()) {
      return status.edit({ embeds: [errEmbed('Empty response', 'The URL returned no content:\n`' + rawUrl + '`')] });
    }

    const sizeMB = Buffer.byteLength(source, 'utf8') / 1024 / 1024;
    if (sizeMB > MAXMB) {
      return status.edit({ embeds: [errEmbed('File too large', `${sizeMB.toFixed(1)} MB (max ${MAXMB} MB)`)] });
    }

    fs.writeFileSync(inp, source, 'utf8');

    await status.edit({ embeds: [
      new EmbedBuilder().setColor(0xF39C12).setTitle('⚙️ Detecting & deobfuscating…')
        .setDescription('Fetched **' + (sizeMB * 1024).toFixed(1) + ' KB** — running pipeline…').setTimestamp()
    ]});

    const args = [inp, '-o', outp, '--timeout', '90'];
    const { stderr } = await runDeob(args, TOMS);
    const elapsed = fmt(Date.now() - t0);
    const obLabel = parseObfuscator(stderr) || 'Unknown';

    if (!fs.existsSync(outp)) throw new Error(stderr.trim() || 'No output produced.');

    const content = fs.readFileSync(outp, 'utf8');
    const sz = content.length < 1024 ? content.length + ' B' : (content.length / 1024).toFixed(1) + ' KB';
    const preview = content.length > 1200
      ? '*(file too large to preview — see attachment)*'
      : '```lua\n' + content.slice(0, 1200) + '\n```';

    await status.edit({
      embeds: [okEmbed('Deobfuscation complete',
        '**Source:** `' + rawInput + '`\n**Detected:** ' + obLabel + '\n**Size:** ' + sz + '\n**Time:** ' + elapsed + '\n\n' + preview)],
      files: [new AttachmentBuilder(Buffer.from(content), { name: 'deob_script.lua' })]
    });
  } catch (e) {
    const elapsed = fmt(Date.now() - t0);
    await status.edit({ embeds: [errEmbed('Deobfuscation failed',
      '**Time:** ' + elapsed + '\n```\n' + e.message.slice(0, 1800) + '\n```')] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Discord client ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', () => {
  console.log('[+] Logged in as ' + client.user.tag);
  client.user.setActivity('Luraph · WeAreDevs · MoonSec 🔍');
});

// ─── Prefix: .l <url> ────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.content.toLowerCase().startsWith('.l ')) return;
  try { await handleLinkCommand(message); } catch (e) { console.error('[!] .l crash:', e); }
});

// ─── Slash commands ──────────────────────────────────────────────────────────
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  const cmd = i.commandName;

  if (cmd === 'help') {
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('🔓 Multi-Obfuscator Deobfuscator')
      .setDescription('Deobfuscate Roblox Luau scripts from multiple obfuscators.\n\n**Method:** Sandbox execution (same fake Roblox environment for all obfuscators). Luraph v15 gets full devirtualization on top.')
      .addFields(
        { name: '🔒 Luraph v15',          value: 'Full devirtualization + CFG reconstruction' },
        { name: '🔓 WeAreDevs',           value: 'Layer-peel: decrypt string table → extract real code' },
        { name: '🔓 MoonSec v2/v3',       value: 'Layer-peel: base-N decode → extract real code' },
        { name: '🔓 IronBrew 2',          value: 'Sandbox trace + layer peel attempt' },
        { name: '🔓 Prometheus',          value: 'Sandbox trace + layer peel attempt' },
        { name: '❓ Unknown obfuscator',  value: 'Sandbox trace (shows what the script does + decrypted strings)' },
        { name: '/deobfuscate',           value: 'Upload a .lua file to deobfuscate' },
        { name: '/detect',                value: 'Identify which obfuscator was used' },
        { name: '.l <url>',               value: 'Fetch from URL and deobfuscate. Supports Pastebin, Pastefy, GitHub, or any direct link.\n`Example: .l https://cloverhub.app/clover.lua`' },
        { name: '⏱ Timings',             value: '• WeAreDevs/MoonSec: 5-30s\n• Luraph small: 1-5s\n• Luraph large: 1-2.5 min' }
      )
      .setFooter({ text: 'Sandbox: envlog.luau (fake Roblox env) | Luraph: full devirtualizer' })
      .setTimestamp()
    ] });
  }

  if (cmd === 'detect') {
    const att = i.options.getAttachment('script');
    const err = validate(att);
    if (err) return i.reply({ embeds: [errEmbed('Invalid file', err)], ephemeral: true });
    await i.deferReply();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luraph-'));
    const inp = path.join(tmp, att.name);
    try {
      await dlFile(att.url, inp);
      const { stdout, stderr } = await runDeob([inp, '--detect'], 30000);
      const out = (stdout + '\n' + stderr).trim();
      // Parse the detect output: filename\tobfname\tconfidence\tlabel
      const parts = stdout.trim().split('\t');
      const label = parts[3] || parts[1] || 'Unknown';
      const conf  = parts[2] ? (parseFloat(parts[2]) * 100).toFixed(0) + '%' : '?';
      await i.editReply({ embeds: [new EmbedBuilder()
        .setColor(0x9B59B6).setTitle('🔍 Detection Result')
        .addFields(
          { name: 'File',       value: '`' + att.name + '`', inline: true },
          { name: 'Obfuscator', value: label,                 inline: true },
          { name: 'Confidence', value: conf,                   inline: true }
        )
        .setDescription('```\n' + out.slice(0, 1800) + '\n```')
        .setTimestamp()] });
    } catch (e) {
      await i.editReply({ embeds: [errEmbed('Detection failed', '```\n' + e.message.slice(0, 1800) + '\n```')] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }

  if (cmd === 'deobfuscate') {
    const att   = i.options.getAttachment('script');
    const nodev = i.options.getBoolean('no_devirt') ?? false;
    const tsec  = i.options.getInteger('timeout') ?? 90;
    const err   = validate(att);
    if (err) return i.reply({ embeds: [errEmbed('Invalid file', err)], ephemeral: true });
    await i.deferReply();
    const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'luraph-'));
    const inp  = path.join(tmp, att.name);
    const outp = path.join(tmp, 'deob_' + att.name);
    const t0   = Date.now();
    try {
      await dlFile(att.url, inp);
      const args = [inp, '-o', outp, '--timeout', String(tsec)];
      if (nodev) args.push('--no-devirt');
      const { stderr } = await runDeob(args, TOMS);
      const elapsed  = fmt(Date.now() - t0);
      const obLabel  = parseObfuscator(stderr) || 'Unknown';
      if (!fs.existsSync(outp)) throw new Error(stderr.trim() || 'No output produced.');
      const content = fs.readFileSync(outp, 'utf8');
      const sz = content.length < 1024 ? content.length + ' B' : (content.length / 1024).toFixed(1) + ' KB';
      const preview = content.length > 1200 ? '*(see attachment)*' : '```lua\n' + content.slice(0, 1200) + '\n```';
      await i.editReply({
        embeds: [okEmbed('Deobfuscation complete',
          '**File:** `' + att.name + '`\n**Detected:** ' + obLabel +
          '\n**Size:** ' + sz + '\n**Time:** ' + elapsed + '\n\n' + preview)],
        files: [new AttachmentBuilder(Buffer.from(content), { name: 'deob_' + att.name })]
      });
    } catch (e) {
      const elapsed = fmt(Date.now() - t0);
      await i.editReply({ embeds: [errEmbed('Deobfuscation failed',
        '**Time:** ' + elapsed + '\n```\n' + e.message.slice(0, 1800) + '\n```')] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
});

client.login(TOKEN);
