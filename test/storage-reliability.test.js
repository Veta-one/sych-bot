const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const moduleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sych-storage-module-'));
process.env.SYCH_DATA_DIR = moduleDataDir;

const {
  StorageService,
  atomicWriteJsonSync,
} = require('../src/services/storage');

const tempDirs = [moduleDataDir];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    const resolved = path.resolve(dir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
});

test('storage writes valid JSON atomically without leaving temp files', () => {
  const dataDir = makeTempDir('sych-storage-atomic-');
  const storage = new StorageService({ dataDir });

  storage.data.chats['-100'] = { mutedTopics: [], users: { 42: '@tester' } };
  storage.profiles['-100'] = { 42: { facts: 'любит тесты', relationship: 80 } };
  storage._saveToFile();
  storage._saveProfilesToFile();

  assert.equal(JSON.parse(fs.readFileSync(storage.paths.db, 'utf8')).chats['-100'].users['42'], '@tester');
  assert.equal(JSON.parse(fs.readFileSync(storage.paths.profiles, 'utf8'))['-100']['42'].facts, 'любит тесты');
  assert.deepEqual(
    fs.readdirSync(dataDir).filter(name => name.endsWith('.tmp')),
    []
  );
});

test('storage rotates snapshots and restores corrupted JSON from the newest backup', () => {
  const dataDir = makeTempDir('sych-storage-backup-');
  let now = new Date('2026-07-28T10:00:00.000Z');
  const storage = new StorageService({
    dataDir,
    backupRetention: 2,
    clock: () => now,
  });

  storage.profiles = { '-100': { 42: { facts: 'первая версия' } } };
  storage._saveProfilesToFile();
  assert.ok(storage.backupNow());

  now = new Date('2026-07-28T11:00:00.000Z');
  storage.profiles['-100']['42'].facts = 'последняя целая версия';
  storage._saveProfilesToFile();
  assert.ok(storage.backupNow());

  now = new Date('2026-07-28T12:00:00.000Z');
  assert.ok(storage.backupNow());
  assert.equal(fs.readdirSync(storage.paths.backups).length, 2);

  fs.writeFileSync(storage.paths.profiles, '{"оборвано":', 'utf8');
  const recovered = new StorageService({ dataDir, backupRetention: 2 });
  assert.equal(recovered.profiles['-100']['42'].facts, 'последняя целая версия');
  assert.equal(JSON.parse(fs.readFileSync(recovered.paths.profiles, 'utf8'))['-100']['42'].facts, 'последняя целая версия');

  fs.unlinkSync(recovered.paths.profiles);
  const recoveredMissing = new StorageService({ dataDir, backupRetention: 2 });
  assert.equal(recoveredMissing.profiles['-100']['42'].facts, 'последняя целая версия');
});

test('forgetUser removes persistent personal data across chats immediately', async () => {
  const dataDir = makeTempDir('sych-storage-forget-');
  const storage = new StorageService({ dataDir });

  storage.data.chats = {
    '-100': { mutedTopics: [], users: { 42: '@Tester', 77: '@Other' } },
    '-200': { mutedTopics: [], users: { 42: '@Tester' } },
    '42': { chatName: 'Tester', mutedTopics: [], users: { 42: '@Tester' } },
  };
  storage.data.reminders = [
    { id: 1, userId: 42, text: 'секрет' },
    { id: 2, userId: 77, text: 'оставить' },
  ];
  storage.profiles = {
    '-100': { 42: { facts: 'секрет' }, 77: { facts: 'другой' } },
    '-200': { 42: { facts: 'ещё секрет' } },
    '42': { _chatName: 'Tester', 42: { facts: 'приватный секрет' } },
  };
  storage.chatProfiles = {
    '-100': { topic: 'тест', facts: 'Tester любит тесты' },
    '-200': { topic: 'ещё тест' },
    '42': { topic: 'приватный чат Tester' },
    '-300': { topic: 'не затронут' },
  };
  atomicWriteJsonSync(storage.paths.instructions, {
    tester: 'личная инструкция',
    other: 'оставить',
  });
  storage._saveToFile();
  storage._saveProfilesToFile();
  storage._saveChatProfilesToFile();
  assert.ok(storage.backupNow());

  const result = await storage.forgetUser(42, '@Tester');

  assert.deepEqual(result, {
    profilesRemoved: 3,
    chatReferencesRemoved: 3,
    remindersRemoved: 1,
    instructionsRemoved: 1,
    chatProfilesReset: 3,
    backupsScrubbed: 1,
  });
  assert.equal(storage.profiles['-100']['42'], undefined);
  assert.equal(storage.profiles['-100']['77'].facts, 'другой');
  assert.equal(storage.data.chats['-100'].users['42'], undefined);
  assert.equal(storage.data.chats['42'], undefined);
  assert.equal(storage.data.reminders.length, 1);
  assert.equal(storage.chatProfiles['-100'], undefined);
  assert.equal(storage.chatProfiles['42'], undefined);
  assert.equal(storage.chatProfiles['-300'].topic, 'не затронут');
  storage.updateChatProfile('-100', { topic: 'устаревший фоновый анализ' });
  assert.equal(storage.chatProfiles['-100'], undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(storage.paths.instructions, 'utf8')), { other: 'оставить' });
  assert.equal(JSON.parse(fs.readFileSync(storage.paths.profiles, 'utf8'))['-200']['42'], undefined);

  const backupDir = path.join(storage.paths.backups, fs.readdirSync(storage.paths.backups)[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupDir, 'profiles.json'), 'utf8'))['-100']['42'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupDir, 'profiles.json'), 'utf8'))['42'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupDir, 'db.json'), 'utf8')).reminders.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupDir, 'db.json'), 'utf8')).chats['42'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupDir, 'chatProfiles.json'), 'utf8'))['-100'], undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backupDir, 'instructions.json'), 'utf8')), { other: 'оставить' });
});
