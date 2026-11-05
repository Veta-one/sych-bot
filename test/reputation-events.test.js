const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sych-reputation-events-'));
process.env.SYCH_DATA_DIR = path.join(dir, 'module');
const { StorageService } = require('../src/services/storage');
let index = 0;
function store(score = 50) {
  const storage = new StorageService({ dataDir: path.join(dir, String(++index)) });
  storage.profiles = { '-100': { 42: { relationship: score, attitude: 'Сохранённое отношение', facts: 'Сохранённая память' } } };
  return storage;
}
async function apply(storage, messageId, delta, attitude) {
  storage.bulkUpdateProfiles('-100', { 42: { relationshipEvent: { messageId, delta, ...(attitude === undefined ? {} : { attitude }) } } });
  await storage.profileUpdateQueue;
  storage.saveProfilesDebounced.flush();
  return storage.getProfile('-100', 42);
}
test.after(() => {
  const resolved = path.resolve(dir);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('delayed positive and neutral events apply to the current score instead of a stale snapshot', async () => {
  for (const events of [[[20, 3], [21, 1]], [[21, 1], [20, 3]]]) {
    const storage = store();
    for (const [id, delta] of events) await apply(storage, id, delta);
    assert.equal(storage.getProfile('-100', 42).relationship, 54);
    assert.equal((await apply(storage, 22, 0)).relationship, 54);
  }
  assert.equal((await apply(store(), 1, -1)).relationship, 49, 'A minus one event is not inflated to minus five');
});

test('duplicate events cannot change score or attitude, including after a disk reload', async () => {
  const storage = store();
  await apply(storage, 20, 3, 'Новое отношение');
  await apply(storage, 20, -3, 'Повтор не должен заменить мнение');
  const reloaded = new StorageService({ dataDir: storage.dataDir });
  const profile = await apply(reloaded, 20, -3, 'Повтор после перезапуска');
  assert.equal(profile.relationship, 53);
  assert.equal(profile.attitude, 'Новое отношение');
  assert.equal(profile.facts, 'Сохранённая память');
  assert.deepEqual(profile.relationshipEvents.ids, [20]);
});

test('out-of-order distinct messages retain the latest attitude while applying every delta', async () => {
  const storage = store();
  await apply(storage, 30, 1, 'Самое свежее мнение');
  await apply(storage, 28, 3, 'Старое мнение');
  const profile = await apply(storage, 29, -1, 'Ещё одно старое мнение');
  assert.equal(profile.relationship, 53);
  assert.equal(profile.attitude, 'Самое свежее мнение');
  assert.deepEqual(profile.relationshipEvents.ids, [28, 29, 30]);
});

test('bounded persisted IDs reject evicted and older events but accept gaps still inside the window', async () => {
  const storage = store();
  for (let id = 2; id <= 514; id += 2) {
    storage.bulkUpdateProfiles('-100', { 42: { relationshipEvent: { messageId: id, delta: 0 } } });
  }
  await storage.profileUpdateQueue;
  storage.saveProfilesDebounced.flush();
  const reloaded = new StorageService({ dataDir: storage.dataDir });
  let profile = reloaded.getProfile('-100', 42);
  assert.equal(profile.relationshipEvents.ids.length, 256);
  assert.equal(profile.relationshipEvents.floor, 2);
  await apply(reloaded, 2, -3); await apply(reloaded, 1, -3);
  profile = await apply(reloaded, 513, 1);
  assert.equal(profile.relationship, 51);
  assert.equal(profile.relationshipEvents.ids.length, 256);
  assert.ok(profile.relationshipEvents.floor >= 4);
  assert.equal((await apply(reloaded, 513, 1)).relationship, 51);
});

test('legacy absolute scores, bare attitude and malformed event fields are ignored', async () => {
  const storage = store();
  storage.bulkUpdateProfiles('-100', { 42: { relationship: 0, attitude: 'Подмена из batch' } });
  await storage.profileUpdateQueue;
  for (const [id, delta] of [[0, 1], [-1, 1], [1.5, 1], ['20', 1], [Number.MAX_SAFE_INTEGER + 1, 1],
    [20, -4], [21, 4], [22, 0.5], [23, '1'], [24, NaN]]) await apply(storage, id, delta, 'Нельзя записывать');
  const profile = storage.getProfile('-100', 42);
  assert.equal(profile.relationship, 50);
  assert.equal(profile.attitude, 'Сохранённое отношение');
  assert.equal(profile.relationshipEvents, undefined);
});

test('a stale revision is checked when the queued write actually executes', async () => {
  const storage = store();
  let release;
  storage.profileUpdateQueue = new Promise(resolve => { release = resolve; });
  let current = true;
  storage.bulkUpdateProfiles('-100', { 42: { relationshipEvent: { messageId: 20, delta: 3 },
    factEvidence: [{ userId: '42', messageId: '20', quote: 'Не возвращать после удаления.' }] } }, { isCurrent: () => current });
  current = false; release(); await storage.profileUpdateQueue;
  storage.saveProfilesDebounced.flush();
  assert.equal(storage.getProfile('-100', 42).relationship, 50);
  assert.equal(storage.getProfile('-100', 42).factEvidence, undefined);
});

test('score boundaries clamp the applied delta and zero remains a valid score', async () => {
  assert.equal((await apply(store(0), 1, -3)).relationship, 0);
  assert.equal((await apply(store(99), 1, 3)).relationship, 100);
  assert.equal((await apply(store(0), 1, 1)).relationship, 1);
});
