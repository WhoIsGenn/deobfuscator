'use strict';

// ─── Luraph v15 ──────────────────────────────────────────────────────────────
const LURAPH_HEADER   = /This file was protected using Luraph Obfuscator v(\d+)(?:\.(\d+))?/;
const LURAPH_VM_SHAPE = /\[\d+\]=(bit32|buffer|string|table|math)\.\w+/;

function detectLuraph(source) {
  const head500 = source.slice(0, 500);
  const m = LURAPH_HEADER.exec(head500);
  if (m) return m[1] === '15' ? 1.0 : 0.3;
  const head2k = source.trimStart().slice(0, 2000);
  if (head2k.startsWith('return setmetatable({') &&
      (LURAPH_VM_SHAPE.test(head2k) || source.slice(0, 200000).includes('LPH')))
    return 0.8;
  return 0.0;
}

const HEADER_LINE_RE = /\s*--[ \t]*This file was protected using Luraph Obfuscator v[\d.]+[ \t]*\[https?:\/\/lura\.ph\/?]/;
function restoreHeaderNewline(source) {
  const m = HEADER_LINE_RE.exec(source);
  if (m) {
    const end = m.index + m[0].length;
    const next = source[end];
    if (next !== '' && next !== '\n' && next !== '\r')
      return source.slice(0, end) + '\n' + source.slice(end).replace(/^[ \t]+/, '');
  }
  return source;
}

// ─── WeAreDevs (WRD) ─────────────────────────────────────────────────────────
// Typical shape: a large table of numbers assigned to a local, then a function
// that reads from that table and string.char()s/xor-decodes strings. Key
// signatures: "WeAreDevs" or "wrd_" in first 1 KB, or the characteristic
// table-of-bytes + string.char decoder pattern.
function detectWRD(source) {
  const head1k = source.slice(0, 1000);
  if (/WeAreDevs/i.test(head1k) || /\bwrd_\w+\s*=/.test(head1k)) return 1.0;
  // Large flat number table at top + string.char xor decoder
  const head4k = source.slice(0, 4000);
  if (/local\s+\w+\s*=\s*\{[\d\s,]+\}/.test(head4k) &&
      /string\.char\([^)]*\bxor\b|bit32\.bxor/.test(source.slice(0, 20000)) &&
      /for\s+\w+\s*=\s*\d+\s*,\s*#/.test(head4k))
    return 0.75;
  // WRD v2: self-calling boot function with hardcoded key table
  if (/\(\s*function\s*\(\s*\)\s*local\s+\w+\s*=\s*\{[\d,\s]+\}/.test(head4k) &&
      /string\.char/.test(head4k))
    return 0.6;
  return 0.0;
}

// ─── MoonSec (v2 / v3) ───────────────────────────────────────────────────────
// MoonSec v2: starts with a comment "-- Obfuscated with MoonSec" OR has the
// characteristic base-conversion bootstrap + long base91/85 data string.
// MoonSec v3: no header comment; uses a large base64/base91 payload string
// followed by a short bootstrap that loadstring()s the result.
const MOONSEC_HEADER = /--\s*(?:Obfuscated|Protected)\s+(?:with|by)\s+Moon(?:Sec|sec|Security)/i;

function detectMoonSec(source) {
  const head2k = source.slice(0, 2000);
  if (MOONSEC_HEADER.test(head2k)) return 1.0;
  // MoonSec v2/v3 bootstrap: local <VAR> = <long base-N string>
  // followed by a numeric-keyed decoder table and loadstring
  const head6k = source.slice(0, 6000);
  const hasLongStr  = /local\s+\w+\s*=\s*["'][A-Za-z0-9+/=!@#$%^&*()_\-]{200,}["']/.test(head6k);
  const hasDecTable = /local\s+\w+\s*=\s*\{(?:\s*\d+\s*,){20,}/.test(head6k);
  const hasLoadstr  = /loadstring\s*\(/.test(head6k);
  if (hasLongStr && hasLoadstr) return 0.85;
  if (hasDecTable && hasLoadstr) return 0.75;
  // MoonSec v3: giant single-line data blob, tiny executor
  if (/^local\s+\w+\s*=\s*["'][A-Za-z0-9+/=!]{500,}["']\s*$/m.test(source.slice(0, 300)) &&
      hasLoadstr)
    return 0.90;
  return 0.0;
}

// ─── IronBrew 2 ──────────────────────────────────────────────────────────────
// IronBrew 2 outputs a comment block starting with "--[[ IronBrew 2" or
// similar, followed by a VM in a single large function.
function detectIronBrew(source) {
  const head1k = source.slice(0, 1000);
  if (/IronBrew\s*2/i.test(head1k)) return 1.0;
  if (/--\[\[\s*Virtualized\s+with\s+IronBrew/i.test(head1k)) return 1.0;
  // IB2 shape: local VM = { [1]=..., [2]=... } opcodes table at the top
  const head4k = source.slice(0, 4000);
  if (/local\s+\w+\s*=\s*\{(?:\s*\[1\]\s*=\s*function|(?:\s*function\s+\w+){3})/.test(head4k) &&
      /VM_EXECUTE|EXECUTE|WRAP|DESERIALIZE|BXOR/.test(source.slice(0, 30000)))
    return 0.7;
  return 0.0;
}

// ─── Prometheus ──────────────────────────────────────────────────────────────
function detectPrometheus(source) {
  const head1k = source.slice(0, 1000);
  if (/Prometheus/i.test(head1k)) return 1.0;
  // Prometheus uses a specific header format + constant string table
  if (/--\s*Protected\s+by\s+Prometheus/i.test(head1k)) return 1.0;
  return 0.0;
}

// ─── Generic VM (any string-table + loadstring VM) ───────────────────────────
// Catches anything else that has a decryption bootstrap into a loadstring VM.
function detectGenericVM(source) {
  const head8k = source.slice(0, 8000);
  let score = 0;
  if (/loadstring\s*\(/.test(head8k)) score += 0.2;
  if (/string\.char\s*\(/.test(head8k)) score += 0.15;
  if (/bit32\.bxor|bxor\s*\(/.test(head8k)) score += 0.15;
  if (/for\s+\w+\s*=\s*1\s*,\s*#\w+/.test(head8k)) score += 0.1;
  if (/local\s+\w+\s*=\s*\{[\d,\s]{100,}\}/.test(head8k)) score += 0.15;
  // Has a large encoded string (base64-like or just packed bytes)
  if (/["'][A-Za-z0-9+/=\\]{300,}["']/.test(source.slice(0, 10000))) score += 0.15;
  return Math.min(score, 0.55); // never beats a named obfuscator
}

const PLUGINS = [
  { name: 'luraph_v15',  label: 'Luraph v15',   detect: detectLuraph    },
  { name: 'wearedevs',   label: 'WeAreDevs',     detect: detectWRD       },
  { name: 'moonsec',     label: 'MoonSec',        detect: detectMoonSec   },
  { name: 'ironbrew2',   label: 'IronBrew 2',    detect: detectIronBrew  },
  { name: 'prometheus',  label: 'Prometheus',    detect: detectPrometheus },
  { name: 'generic_vm',  label: 'Unknown VM',    detect: detectGenericVM },
];

function detect(source) {
  let best = { plugin: null, confidence: 0 };
  for (const p of PLUGINS) {
    const c = p.detect(source);
    if (c > best.confidence) best = { plugin: p, confidence: c };
  }
  if (!best.plugin || best.confidence < 0.3) {
    return { plugin: { name: 'generic', label: 'Unknown obfuscator' }, confidence: 0 };
  }
  return { plugin: best.plugin, confidence: best.confidence };
}

function byName(name) {
  const p = PLUGINS.find(x => x.name === name);
  if (!p) throw new Error(`Unknown obfuscator '${name}' (known: ${PLUGINS.map(x => x.name).join(', ')})`);
  return p;
}

module.exports = { detect, byName, restoreHeaderNewline, PLUGINS };
