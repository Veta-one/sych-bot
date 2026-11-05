#!/usr/bin/env node
// Offline maintenance: stop the bot before applying. No API calls or storage singleton.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function resetReputation({ dataDir, apply = false, botStopped = false }) {
  if (apply && !botStopped) throw new Error('STOP_BOT_REQUIRED');
  const directory = path.resolve(dataDir);
  const source = path.join(directory, 'profiles.json');
  const original = fs.readFileSync(source);
  let profiles;
  try { profiles = JSON.parse(original.toString('utf8')); } catch { throw new Error('INVALID_PROFILES_JSON'); }
  if (!record(profiles)) throw new Error('INVALID_PROFILES_SHAPE');
  let total = 0;
  let changed = 0;
  for (const [chatId, users] of Object.entries(profiles)) {
    if (!/^-?\d+$/.test(chatId) || !record(users)) throw new Error('INVALID_PROFILES_SHAPE');
    for (const [userId, profile] of Object.entries(users)) {
      // Real files include chat metadata and may retain legacy username-keyed profiles.
      if (userId === '_chatName' && typeof profile === 'string') continue;
      if (!record(profile)) throw new Error('INVALID_PROFILES_SHAPE');
      total++;
      if (profile.relationship !== 50) {
        profile.relationship = 50;
        changed++;
      }
    }
  }
  const result = { mode: apply ? 'apply' : 'preview', total, changed, target: 50, backup: null };
  if (!apply || !changed) return result;

  // Standard snapshot layout lets the existing forget-user command scrub this backup too.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(directory, 'backups', `${stamp}-reputation-reset-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(backup, 'profiles.json'), original, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(), operation: 'reset-reputation', files: ['profiles.json'], total, changed,
  }, null, 2), { flag: 'wx', mode: 0o600 });
  result.backup = backup;

  const temporary = path.join(directory, `.profiles-reset-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(profiles, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (!fs.readFileSync(source).equals(original)) throw new Error('PROFILES_CHANGED_RETRY_OFFLINE');
    fs.renameSync(temporary, source);
    try {
      const folder = fs.openSync(directory, 'r');
      try { fs.fsyncSync(folder); } finally { fs.closeSync(folder); }
    } catch { /* Directory fsync is unavailable on Windows. */ }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return result;
}

function main(args) {
  const options = { dataDir: process.env.SYCH_DATA_DIR || path.join(__dirname, '../data') };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--bot-stopped') options.botStopped = true;
    else if (arg === '--data-dir' && args[index + 1] && !args[index + 1].startsWith('--')) options.dataDir = args[++index];
    else if (arg === '--help' && args.length === 1) {
      console.log('Stop the bot first. Preview: node scripts/reset-reputation.js [--data-dir PATH]. Apply: add --apply --bot-stopped. Only relationship becomes 50; memory and event history remain.');
      return;
    } else throw new Error('INVALID_ARGUMENTS');
  }
  console.log(JSON.stringify(resetReputation(options), null, 2));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const known = new Set(['STOP_BOT_REQUIRED', 'INVALID_PROFILES_JSON', 'INVALID_PROFILES_SHAPE', 'PROFILES_CHANGED_RETRY_OFFLINE', 'INVALID_ARGUMENTS']);
    console.error(`[REPUTATION RESET] ${known.has(error.message) ? error.message : 'RESET_FAILED'}`);
    process.exitCode = 1;
  }
}
module.exports = { resetReputation };
