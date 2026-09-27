/**
 * generic_deob.js
 *
 * Deobfuscation engine for WeAreDevs, MoonSec, IronBrew2, Prometheus, and any
 * unknown VM obfuscator. Strategy:
 *
 *  1. SANDBOX EXECUTION (same envlog.luau harness used by Luraph):
 *     Run the script in the fake Roblox sandbox. The sandbox intercepts every
 *     API call, loadstring, string.char, bit32.bxor, etc. and logs them.
 *     This gives us the decrypted string table + the decrypted VM bytecode
 *     that gets loadstring()'d.
 *
 *  2. LAYER PEELING:
 *     Most obfuscators (WRD, MoonSec, some IB2 variants) are "string-table +
 *     loadstring" obfuscators: they decrypt a string → loadstring it → the
 *     real code runs. The sandbox catches the loadstring argument (the real
 *     payload) and we write that out. If the payload is itself obfuscated we
 *     peel another layer.
 *
 *  3. POST-PROCESSING:
 *     After up to MAX_LAYERS peels, we run the tidy pass (same as Luraph) and
 *     collect any decrypted strings the sandbox captured to annotate the output.
 *
 *  4. WHAT WE CANNOT DO (honest):
 *     We cannot reconstruct variable names or control-flow structure for a VM
 *     obfuscator (like Luraph) without a full devirtualizer written specifically
 *     for that VM. The sandbox trace gives you readable recovered code for
 *     string-table obfuscators, and the actual executed statements for VM
 *     obfuscators — which is still far more useful than the original.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const harness = require('./harness');
const tidy    = require('./tidy');

const MAX_LAYERS = 4;

/**
 * Check if source looks like it might be another obfuscation layer worth peeling.
 */
function looksObfuscated(src) {
  if (src.length < 100) return false;
  const head = src.slice(0, 4000);
  return (
    /loadstring\s*\(/.test(head) ||
    /string\.char\s*\(/.test(head) ||
    /bit32\.bxor/.test(head) ||
    (/local\s+\w+\s*=\s*\{[\d,\s]{60,}\}/.test(head) && /string\.char/.test(head))
  );
}

/**
 * Extract loadstring'd source code from a sandbox trace.
 * The envlog harness logs: `-- loadstring() of N bytes: "<first 200 chars>"`
 * and emits a CHUNK marker with the hex-encoded full source.
 *
 * Returns: array of { key, source } objects, or [] if none found.
 */
function extractLoadstringPayloads(body, chunks) {
  const payloads = [];
  // chunks is a map of key -> source (filled by harness.takeChunks)
  for (const [key, src] of Object.entries(chunks)) {
    if (src && src.length > 50) payloads.push({ key, source: src });
  }
  // Also look for inline loadstring results in the trace body itself
  const re = /-- loadstring\(\) of \d+ bytes: "([\s\S]*?)"\n([\s\S]*?)(?=\n--|$)/g;
  return payloads;
}

/**
 * Parse the sandbox trace body and extract human-readable statements.
 * Strips envlog internal markers, leaving the API call log.
 */
function parseTraceBody(body) {
  if (!body) return '';
  let text = body;
  // Remove internal markers
  text = text.replace(/\x00(PROTOS|FORCE|P2D|TRIGGER|CHUNK|FETCH|HB)[^\n]*\n?/g, '');
  text = text.replace(/\x00ENVLOG-BEGIN\n?/g, '');
  text = text.replace(/\x00ENVLOG-END\n?/g, '');
  text = text.replace(/\x00ENVLOG-STRINGS\n?/g, '');
  return text;
}

/**
 * Try to extract the cleanest possible readable output for string-table obfuscators.
 *
 * For WRD/MoonSec/etc., the flow is:
 *   1. Script decrypts string table (we see bit32.bxor / string.char calls)
 *   2. Script calls loadstring(decrypted_code)
 *   3. The decrypted code is the real script
 *
 * We return the largest loadstring payload as the result.
 */
function extractBestPayload(chunks) {
  if (!chunks || Object.keys(chunks).length === 0) return null;
  // Return the largest chunk — it's most likely the real payload
  let best = null;
  let bestLen = 0;
  for (const [, src] of Object.entries(chunks)) {
    if (src && src.length > bestLen) { best = src; bestLen = src.length; }
  }
  return best;
}

/**
 * Collect decrypted strings from the trace for annotation.
 */
function collectStrings(body) {
  const strings = [];
  const re = /-- \[envlog\] string decrypted: (.*)/g;
  let m;
  while ((m = re.exec(body)) !== null) strings.push(m[1]);
  return strings;
}

/**
 * Main deobfuscation entry point for non-Luraph obfuscators.
 * job: same Job object as used by the Luraph path.
 */
async function deobfuscate(job) {
  const { args } = job;
  const runner = new harness.Runner(job);

  const cfg = {
    time_budget: args.budget || 30,
    executor: args.executor || 'Wave',
    dump_strings: true,
    fold: true,
  };

  let currentSource = job.source;
  let finalOutput   = null;
  let layerCount    = 0;
  let allStrings    = [];
  let traceBody     = '';

  // ── Layer peeling loop ───────────────────────────────────────────────────
  for (let layer = 1; layer <= MAX_LAYERS; layer++) {
    layerCount = layer;
    process.stderr.write(`[*] generic deob layer ${layer}: running sandbox...\n`);

    const res = await runner.run(currentSource, cfg);
    if (!res.body) {
      process.stderr.write(`[!] sandbox returned no output: ${(res.err || '').slice(0, 400)}\n`);
      break;
    }

    traceBody = res.body;

    // Collect decrypted strings
    const strings = collectStrings(traceBody);
    allStrings = allStrings.concat(strings);
    if (strings.length > 0)
      process.stderr.write(`[*] layer ${layer}: captured ${strings.length} decrypted strings\n`);

    // Pull out loadstring'd chunks
    const { chunks: foundChunks, body: cleanBody } = harness.takeChunks(traceBody);
    traceBody = cleanBody;

    const chunks = {};
    for (const [key, src] of foundChunks) chunks[key] = src;

    const payload = extractBestPayload(chunks);

    if (payload) {
      process.stderr.write(`[*] layer ${layer}: found loadstring payload (${payload.length} bytes)\n`);
      if (looksObfuscated(payload) && layer < MAX_LAYERS) {
        process.stderr.write(`[*] layer ${layer}: payload looks obfuscated, peeling next layer\n`);
        currentSource = payload;
        continue;
      }
      // Clean payload — this is the result
      finalOutput = payload;
      break;
    }

    // No loadstring payload found — the trace IS the output (VM obfuscator)
    process.stderr.write(`[*] layer ${layer}: no loadstring payload; using sandbox trace as output\n`);
    finalOutput = null;
    break;
  }

  runner.finish();

  // ── Build output ─────────────────────────────────────────────────────────
  let output;

  if (finalOutput) {
    // We have a clean peeled payload — output that directly
    const header = [
      `-- Deobfuscated by generic sandbox (${layerCount} layer${layerCount > 1 ? 's' : ''} peeled)`,
      `-- Original obfuscator: ${job.obfuscator || 'unknown'}`,
      `-- Captured ${allStrings.length} decrypted string(s)`,
      '',
    ].join('\n');

    // Annotate with string table if we have it
    let stringAnnotation = '';
    if (allStrings.length > 0 && allStrings.length <= 200) {
      stringAnnotation = '\n\n--[[ Decrypted string table:\n' +
        allStrings.map((s, i) => `  [${i + 1}] ${s}`).join('\n') +
        '\n]]\n';
    }

    output = header + finalOutput + stringAnnotation;
  } else {
    // No clean payload — use the sandbox trace as the output
    // This is what the VM actually DID (all API calls, strings, logic observed)
    const traceText = parseTraceBody(traceBody);
    const header = [
      `-- Sandbox behaviour trace (no clean payload extracted)`,
      `-- Obfuscator: ${job.obfuscator || 'unknown'}`,
      `-- This shows what the script DID: every Roblox API call, decrypted string,`,
      `-- and operation observed during sandboxed execution.`,
      `-- For a VM obfuscator, this is the best automatic output available.`,
      '',
    ].join('\n');

    let stringSection = '';
    if (allStrings.length > 0) {
      stringSection = '\n--[[ Decrypted strings captured during execution:\n' +
        allStrings.slice(0, 500).map((s, i) => `  [${i + 1}] ${s}`).join('\n') +
        (allStrings.length > 500 ? `\n  ... and ${allStrings.length - 500} more` : '') +
        '\n]]\n';
    }

    output = header + traceText + stringSection;
  }

  // Run the tidy pass
  const tidied = tidy.tidy(output, { preamble: false });

  // Write result
  const outPath = job.args.output || job.tracePath;
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, tidied, 'utf8');
  process.stderr.write(`[+] generic deob result: ${outPath}\n`);
  return outPath;
}

module.exports = { deobfuscate };
