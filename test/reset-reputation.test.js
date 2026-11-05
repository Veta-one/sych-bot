const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resetReputation } = require('../scripts/reset-reputation');

function fixture(t, data) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sych-reset-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'profiles.json'), typeof data === 'string' ? data : JSON.stringify(data));
  return directory;
}

test('reset previews without writes, backs up exact source and changes only scores', t => {
  const data = { '-100': { '42': { relationship: 0, facts: 'synthetic fact', attitude: 'old impression',
    factEvidence: [{ userId: '42', messageId: '17', quote: 'synthetic quote' }], relationshipEvents: { ids: [17], floor: 10 }, extra: { keep: true } },
    '43': { relationship: 100 }, '44': { facts: 'no score yet' } }, '-200': { '42': { relationship: 50 } } };
  const directory = fixture(t, data);
  const file = path.join(directory, 'profiles.json');
  const before = fs.readFileSync(file);
  const preview = resetReputation({ dataDir: directory });
  assert.deepEqual(preview, { mode: 'preview', total: 4, changed: 3, target: 50, backup: null });
  assert.ok(fs.readFileSync(file).equals(before));
  assert.deepEqual(fs.readdirSync(directory), ['profiles.json']);
  assert.throws(() => resetReputation({ dataDir: directory, apply: true }), /STOP_BOT_REQUIRED/);
  const result = resetReputation({ dataDir: directory, apply: true, botStopped: true });
  assert.ok(fs.readFileSync(path.join(result.backup, 'profiles.json')).equals(before));
  const actual = JSON.parse(fs.readFileSync(file));
  for (const users of Object.values(data)) for (const profile of Object.values(users)) profile.relationship = 50;
  assert.deepEqual(actual, data);
  assert.equal(resetReputation({ dataDir: directory, apply: true, botStopped: true }).changed, 0);
  assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, 1);
});

test('invalid source cannot be partially reset and CLI does not disclose its contents', t => {
  const script = path.join(__dirname, '../scripts/reset-reputation.js');
  for (const malformed of ['{SECRET_SOURCE', '[]', '{"-100":{"42":null}}', '{"-100":{"42":{"relationship":0},"bad":[]}}']) {
    const directory = fixture(t, malformed);
    const result = spawnSync(process.execPath, [script, '--data-dir', directory, '--apply', '--bot-stopped'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET_SOURCE/);
    assert.equal(fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8'), malformed);
    assert.deepEqual(fs.readdirSync(directory), ['profiles.json']);
  }
});

test('reset snapshot remains compatible with forget-user backup scrubbing', t => {
  const directory = fixture(t, { '-100': { '42': { relationship: 0, facts: 'synthetic forgotten fact' }, '43': { relationship: 9 } } });
  const result = resetReputation({ dataDir: directory, apply: true, botStopped: true });
  const priorDir = process.env.SYCH_DATA_DIR;
  process.env.SYCH_DATA_DIR = directory;
  const { StorageService } = require('../src/services/storage');
  if (priorDir === undefined) delete process.env.SYCH_DATA_DIR; else process.env.SYCH_DATA_DIR = priorDir;
  const storage = new StorageService({ dataDir: directory });
  storage._scrubUserFromBackups('42', new Set());
  const backup = JSON.parse(fs.readFileSync(path.join(result.backup, 'profiles.json')));
  assert.equal(backup['-100']['42'], undefined);
  assert.equal(backup['-100']['43'].relationship, 9);
});

test('reset refuses to write scores when the original cannot be backed up', t => {
  const directory = fixture(t, { '-100': { '42': { relationship: 0, facts: 'synthetic memory' } } });
  const file = path.join(directory, 'profiles.json');
  const before = fs.readFileSync(file);
  fs.writeFileSync(path.join(directory, 'backups'), 'occupied by a file');
  assert.throws(() => resetReputation({ dataDir: directory, apply: true, botStopped: true }));
  assert.ok(fs.readFileSync(file).equals(before));
});

test('actual storage metadata and legacy username keys survive a reset', t => {
  const data = { '-100': { _chatName: 'Synthetic chat', '42': { relationship: 0 },
    '@synthetic_old_name': { relationship: 7, facts: 'legacy synthetic note' } } };
  const directory = fixture(t, data);
  const result = resetReputation({ dataDir: directory, apply: true, botStopped: true });
  assert.equal(result.total, 2);
  assert.equal(result.changed, 2);
  const actual = JSON.parse(fs.readFileSync(path.join(directory, 'profiles.json')));
  assert.deepEqual(actual, { '-100': { _chatName: 'Synthetic chat', '42': { relationship: 50 },
    '@synthetic_old_name': { relationship: 50, facts: 'legacy synthetic note' } } });
});
