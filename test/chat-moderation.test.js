const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const moduleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sych-moderation-module-'));
const previousDataDir = process.env.SYCH_DATA_DIR;
process.env.SYCH_DATA_DIR = moduleDataDir;
const { StorageService } = require('../src/services/storage');
if (previousDataDir === undefined) delete process.env.SYCH_DATA_DIR;
else process.env.SYCH_DATA_DIR = previousDataDir;

const tempDirs = [moduleDataDir];
const instances = [];

function makeStorage(existingDb) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sych-chat-moderation-'));
  tempDirs.push(dataDir);
  if (existingDb) fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(existingDb), 'utf8');
  const storage = new StorageService({ dataDir });
  instances.push(storage);
  return storage;
}

test.after(() => {
  for (const storage of instances) {
    storage.forceSave();
    storage.stopAutomaticBackups();
  }
  for (const dir of tempDirs) {
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('chat-local ban ignores the user in only that chat and has its own unban/list', () => {
  const storage = makeStorage();
  storage.banUserInChat(-100, 42, '@tester');
  storage.banUserInChat(-200, 77, '@other');

  assert.equal(storage.isBanned(42, -100), true);
  assert.equal(storage.isBanned('42', '-100'), true);
  assert.equal(storage.isBanned(42, -200), false);
  assert.equal(storage.isBanned(42), false);
  assert.deepEqual(storage.getBannedList(-100), { 42: '@tester' });
  assert.deepEqual(storage.getBannedList(), {});
  assert.deepEqual(storage.getBannedList(-300), {});
  assert.equal(storage.hasChat(-300), false, 'a moderation lookup does not create an unrelated chat');

  storage.unbanUserInChat(-100, 42);
  assert.equal(storage.isBanned(42, -100), false);
  assert.equal(storage.isBanned(77, -200), true);
  assert.deepEqual(storage.getBannedList(-100), {});
});

test('legacy global bans still apply everywhere and local unban cannot remove them', () => {
  const storage = makeStorage();
  storage.banUser(42, 'legacy ban');
  storage.banUserInChat(-100, 42, 'local ban');
  storage.unbanUserInChat(-100, 42);

  assert.equal(storage.isBanned(42), true);
  assert.equal(storage.isBanned(42, -100), true);
  assert.equal(storage.isBanned(42, -200), true);
  assert.deepEqual(storage.getBannedList(), { 42: 'legacy ban' });
  assert.deepEqual(storage.getBannedList(-100), {});

  storage.banUserInChat(-100, 42, 'local ban');
  storage.unbanUser(42);
  assert.equal(storage.isBanned(42), false);
  assert.equal(storage.isBanned(42, -100), true);
  assert.equal(storage.isBanned(42, -200), false);
});

test('whole-chat mute covers all topics and preserves legacy topic mute on restore', () => {
  const storage = makeStorage();
  assert.equal(storage.isChatMuted(-100), false);
  assert.equal(storage.hasChat(-100), false, 'checking mute must preserve new-contact detection');
  assert.equal(storage.toggleMute(-100, 184), true);
  assert.equal(storage.isTopicMuted(-100, 184), true);
  assert.equal(storage.isTopicMuted(-100, null), false);

  assert.equal(storage.toggleChatMute(-100), true);
  assert.equal(storage.isChatMuted(-100), true);
  for (const topic of [null, undefined, 0, 184, 185, 'general']) {
    assert.equal(storage.isTopicMuted(-100, topic), true, `topic ${topic}`);
  }
  assert.equal(storage.isTopicMuted(-200, 184), false);

  assert.equal(storage.toggleChatMute(-100), false);
  assert.equal(storage.isTopicMuted(-100, 185), false);
  assert.equal(storage.isTopicMuted(-100, null), false);
  assert.equal(storage.isTopicMuted(-100, 184), true, 'legacy topic mute remains deliberate');
  assert.equal(storage.toggleMute(-100, 184), false);
  assert.equal(storage.isTopicMuted(-100, 184), false);
});

test('moderation changes persist through the existing debounced atomic save and reload', () => {
  const storage = makeStorage();
  storage.banUser(77, 'global');
  storage.banUserInChat(-100, 42, 'local');
  storage.toggleMute(-100, 184);
  storage.toggleChatMute(-100);
  storage.forceSave();

  const data = JSON.parse(fs.readFileSync(storage.paths.db, 'utf8'));
  assert.equal(data.chats['-100'].muted, true);
  assert.deepEqual(data.chats['-100'].bannedUsers, { 42: 'local' });
  assert.deepEqual(data.bannedUsers, { 77: 'global' });
  assert.deepEqual(fs.readdirSync(storage.dataDir).filter(name => name.endsWith('.tmp')), []);

  const reloaded = new StorageService({ dataDir: storage.dataDir });
  instances.push(reloaded);
  assert.equal(reloaded.isBanned(42, -100), true);
  assert.equal(reloaded.isBanned(42, -200), false);
  assert.equal(reloaded.isBanned(77, -200), true);
  assert.equal(reloaded.isTopicMuted(-100, 185), true);
  reloaded.toggleChatMute(-100);
  reloaded.unbanUserInChat(-100, 42);
  reloaded.forceSave();
  reloaded.load();
  assert.equal(reloaded.isChatMuted(-100), false);
  assert.equal(reloaded.isTopicMuted(-100, 184), true);
  assert.equal(reloaded.isBanned(42, -100), false);
});

test('old files initialize chat moderation without changing existing bans/topics/users', () => {
  const storage = makeStorage({
    chats: { '-100': { mutedTopics: [0, '184'], users: { 42: '@tester' } }, '-200': { users: {} } },
    bannedUsers: { 77: 'old global ban' },
  });

  assert.equal(storage.isChatMuted(-100), false);
  assert.equal(storage.isTopicMuted(-100, 0), true);
  assert.equal(storage.isTopicMuted(-100, 184), true);
  assert.equal(storage.isTopicMuted(-100, null), false);
  assert.deepEqual(storage.getChat(-100).users, { 42: '@tester' });
  assert.deepEqual(storage.getBannedList(-100), {});
  assert.deepEqual(storage.getChat(-200).mutedTopics, []);
  assert.equal(storage.isBanned(77, -100), true);
  assert.equal(storage.isBanned(42, -100), false);

  storage.toggleChatMute(-200);
  storage.forceSave();
  storage.load();
  assert.equal(storage.isChatMuted(-200), true);
  assert.equal(storage.isTopicMuted(-100, 0), true);
});

test('chat moderation rejects invalid user IDs before creating or changing a chat', () => {
  const storage = makeStorage();
  for (const target of [null, undefined, 0, -1, 1.5, NaN, Infinity, 'tester', '42x', '1e3', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => storage.banUserInChat(-100, target), TypeError, String(target));
    assert.throws(() => storage.unbanUserInChat(-100, target), TypeError, String(target));
  }
  assert.equal(storage.hasChat(-100), false);
  storage.banUserInChat(-100, '00042');
  assert.equal(storage.isBanned(42, -100), true);
  assert.deepEqual(storage.getBannedList(-100), { 42: 'Banned by Admin' });
});

test('forgetting memory scrubs local ban labels including backups but retains moderation', async () => {
  const storage = makeStorage();
  storage.trackUser(-100, { id: 42, username: 'Tester' });
  storage.banUserInChat(-100, 42, '@Tester secret reason');
  storage.banUserInChat(-200, 42, 'name in a group without a tracked profile');
  storage.banUserInChat(-100, 77, '@Other');
  storage.toggleChatMute(-100);
  const backupDir = storage.backupNow();
  assert.ok(backupDir);

  await storage.forgetUser(42, '@Tester');

  assert.equal(storage.isBanned(42, -100), true);
  assert.equal(storage.isBanned(42, -200), true);
  assert.equal(storage.isBanned(42, -300), false);
  assert.equal(storage.isChatMuted(-100), true);
  assert.equal(storage.getBannedList(-100)[42], 'Banned by Admin');
  assert.equal(storage.getBannedList(-200)[42], 'Banned by Admin');
  assert.equal(storage.getBannedList(-100)[77], '@Other');
  assert.equal(storage.getChat(-100).users[42], undefined);
  const backup = JSON.parse(fs.readFileSync(path.join(backupDir, 'db.json'), 'utf8'));
  assert.equal(backup.chats['-100'].bannedUsers[42], 'Banned by Admin');
  assert.equal(backup.chats['-200'].bannedUsers[42], 'Banned by Admin');
  assert.equal(backup.chats['-100'].bannedUsers[77], '@Other');
});
