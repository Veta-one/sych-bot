const assert = require('node:assert/strict');
const test = require('node:test');
const { ensureOwnerEphemeralCommands } = require('../src/services/ephemeral-commands');

const privateNames = ['ask', 'say', 'mute', 'ban'];
const ownerScope = (chat = -100, user = 999) => ({ type: 'chat_member', chat_id: chat, user_id: user });
const scopeKey = (scope, language = '') => `${scope.type}:${scope.chat_id || ''}:${scope.user_id || ''}:${language}`;
const command = name => ({ command: name, description: `Description ${name}` });

function fakeBot(initial = []) {
  const reads = [];
  const writes = [];
  const deletes = [];
  const state = new Map(initial.map(({ scope, language = '', commands }) => [scopeKey(scope, language), commands]));
  const bot = {
    getMyCommands: async options => {
      reads.push(options);
      return state.get(scopeKey(options.scope, options.language_code)) || [];
    },
    setMyCommands: async (commands, options) => {
      writes.push({ commands, options });
      state.set(scopeKey(options.scope, options.language_code), commands);
      return true;
    },
    deleteMyCommands: async options => {
      deletes.push(options);
      state.delete(scopeKey(options.scope, options.language_code));
      return true;
    },
  };
  return { bot, reads, writes, deletes, state };
}

function assertOwnerCommands(commands) {
  const selected = commands.filter(item => privateNames.includes(item.command));
  assert.deepEqual(selected.map(item => item.command), privateNames);
  for (const item of selected) {
    assert.equal(item.is_ephemeral, true);
    assert.match(item.description, /[а-яё]/i);
  }
}

test('replaces the four commands only in the owner menu and preserves unrelated commands', async () => {
  const help = { command: 'help', description: 'Помощь', is_ephemeral: false };
  const status = { command: 'status', description: 'Состояние', is_ephemeral: true };
  const original = [help, ...privateNames.map(command), command('ask'), status];
  const fixture = fakeBot([{ scope: ownerScope(-100123), commands: original }]);
  assert.equal(await ensureOwnerEphemeralCommands(fixture.bot, -100123, 999, ''), true);
  const ownerWrites = fixture.writes.filter(write => write.options.scope.type === 'chat_member');
  assert.equal(ownerWrites.length, 1);
  assert.deepEqual(ownerWrites[0].options, { scope: ownerScope(-100123), language_code: '' });
  assert.deepEqual(ownerWrites[0].commands.slice(0, 2), [help, status]);
  assertOwnerCommands(ownerWrites[0].commands);
  assert.equal(original.filter(item => item.command === 'ask').length, 2);
  assert.equal(original[1].is_ephemeral, undefined);
  assert.equal(fixture.deletes.length, 0);
});

test('inherits the first applicable menu and does not write public menus without private command names', async () => {
  for (const type of ['chat', 'all_group_chats', 'default']) {
    const help = { command: 'help', description: `From ${type}` };
    const sourceScope = type === 'chat' ? { type, chat_id: -100 } : { type };
    const initial = [{ scope: sourceScope, commands: [help] }];
    if (type !== 'default') initial.push({ scope: { type: 'default' }, commands: [command('version')] });
    const fixture = fakeBot(initial);
    await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, '');
    const ownerWrite = fixture.writes.find(write => write.options.scope.type === 'chat_member');
    assert.deepEqual(ownerWrite.commands[0], help);
    assertOwnerCommands(ownerWrite.commands);
    assert.ok(fixture.writes.every(write => write.options.scope.type === 'chat_member'));
    assert.equal(fixture.deletes.length, 0);
    assert.deepEqual(fixture.state.get(scopeKey(sourceScope)), [help]);
  }
});

test('cleans all six public scopes in both languages while keeping other commands and owner menus', async () => {
  const scopes = [
    { type: 'default' }, { type: 'all_private_chats' }, { type: 'all_group_chats' },
    { type: 'all_chat_administrators' }, { type: 'chat', chat_id: -100 },
    { type: 'chat_administrators', chat_id: -100 },
  ];
  const unknown = { command: 'custom_action', description: 'Keep unknown', is_ephemeral: true };
  const initial = scopes.flatMap(scope => ['', 'ru'].map(language => ({
    scope, language, commands: [...privateNames.map(command), unknown],
  })));
  initial.push({ scope: ownerScope(), commands: [command('help'), ...privateNames.map(command)] });
  const fixture = fakeBot(initial);
  await ensureOwnerEphemeralCommands(fixture.bot, -100, 999);
  for (const scope of scopes) {
    for (const language of ['', 'ru']) assert.deepEqual(fixture.state.get(scopeKey(scope, language)), [unknown]);
  }
  for (const language of ['', 'ru']) assertOwnerCommands(fixture.state.get(scopeKey(ownerScope(), language)));
  const cleanedScopes = new Set(fixture.writes.filter(write => write.options.scope.type !== 'chat_member')
    .map(write => scopeKey(write.options.scope, write.options.language_code)));
  assert.equal(cleanedScopes.size, scopes.length * 2);
  assert.ok(fixture.writes.every(write => write.options.scope.type === 'chat_member'
    || write.commands.every(item => !privateNames.includes(item.command))));
  assert.equal(fixture.deletes.length, 0);
});

test('deletes an emptied public scope and uses setMyCommands([]) when delete is unavailable', async () => {
  for (const canDelete of [true, false]) {
    const scope = { type: 'all_group_chats' };
    const fixture = fakeBot([{ scope, commands: privateNames.map(command) }]);
    if (!canDelete) delete fixture.bot.deleteMyCommands;
    await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, '');
    const remaining = fixture.state.get(scopeKey(scope)) || [];
    assert.deepEqual(remaining, []);
    if (canDelete) assert.deepEqual(fixture.deletes, [{ scope, language_code: '' }]);
    else assert.ok(fixture.writes.some(write => write.options.scope.type === scope.type && write.commands.length === 0));
    assertOwnerCommands(fixture.state.get(scopeKey(ownerScope())));
  }
});

test('deduplicates concurrent registration and caches global cleanup separately from chats and owners', async () => {
  const fixture = fakeBot([{ scope: { type: 'default' }, commands: [command('ask'), command('help')] }]);
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureOwnerEphemeralCommands(fixture.bot, -100, 999)));
  assert.ok(results.every(Boolean));
  assert.equal(fixture.writes.filter(write => write.options.scope.type === 'chat_member').length, 2);
  const countAfterSuccess = fixture.reads.length + fixture.writes.length + fixture.deletes.length;
  await ensureOwnerEphemeralCommands(fixture.bot, '-100', '999');
  assert.equal(fixture.reads.length + fixture.writes.length + fixture.deletes.length, countAfterSuccess);
  const cleanupRead = read => read.scope.type === 'all_private_chats';
  const globalReads = fixture.reads.filter(cleanupRead).length;
  await ensureOwnerEphemeralCommands(fixture.bot, -101, 999);
  await ensureOwnerEphemeralCommands(fixture.bot, -100, 998);
  assert.equal(fixture.reads.filter(cleanupRead).length, globalReads);
  assert.ok(fixture.reads.some(read => read.scope.type === 'chat' && read.scope.chat_id === -101));
  assertOwnerCommands(fixture.state.get(scopeKey(ownerScope(-101))));
  assertOwnerCommands(fixture.state.get(scopeKey(ownerScope(-100, 998))));
  const other = fakeBot();
  await ensureOwnerEphemeralCommands(other.bot, -100, 999);
  assert.ok(other.reads.some(cleanupRead));
});

test('allows retry after failed owner reads or writes and shares concurrent failure', async () => {
  for (const phase of ['read', 'write']) {
    const fixture = fakeBot();
    const method = phase === 'read' ? 'getMyCommands' : 'setMyCommands';
    const implementation = fixture.bot[method];
    let ownerCalls = 0;
    fixture.bot[method] = async (...args) => {
      const options = args[phase === 'read' ? 0 : 1];
      if (options.scope.type === 'chat_member' && ++ownerCalls === 1) throw new Error('temporary owner failure');
      return implementation(...args);
    };
    const results = await Promise.allSettled([
      ensureOwnerEphemeralCommands(fixture.bot, -100, 999, ''),
      ensureOwnerEphemeralCommands(fixture.bot, -100, 999, ''),
    ]);
    assert.ok(results.every(result => result.status === 'rejected' && /temporary owner failure/.test(result.reason.message)));
    assert.equal(ownerCalls, 1);
    assert.equal(await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, ''), true);
    assertOwnerCommands(fixture.state.get(scopeKey(ownerScope())));
  }
});

test('retries failed public cleanup without repeating confirmed global cleanup or deleting unrelated commands', async () => {
  const scope = { type: 'all_group_chats' };
  const help = command('help');
  const fixture = fakeBot([{ scope, commands: [command('ask'), help] }]);
  const implementation = fixture.bot.setMyCommands;
  let failCleanup = true;
  fixture.bot.setMyCommands = async (commands, options) => {
    if (options.scope.type === scope.type && failCleanup) throw new Error('cleanup unavailable');
    return implementation(commands, options);
  };
  await assert.rejects(ensureOwnerEphemeralCommands(fixture.bot, -100, 999, ''), /cleanup unavailable/);
  assert.deepEqual(fixture.state.get(scopeKey(scope)), [command('ask'), help]);
  assert.ok(!fixture.state.has(scopeKey(ownerScope())));
  const completedReadCount = fixture.reads.filter(read => read.scope.type === 'all_private_chats').length;
  failCleanup = false;
  await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, '');
  assert.equal(fixture.reads.filter(read => read.scope.type === 'all_private_chats').length, completedReadCount);
  assert.deepEqual(fixture.state.get(scopeKey(scope)), [help]);
  assertOwnerCommands(fixture.state.get(scopeKey(ownerScope())));
});

test('requires explicit confirmation of owner registration and public cleanup', async () => {
  for (const failingScope of ['chat_member', 'default']) {
    const fixture = fakeBot([{ scope: { type: 'default' }, commands: [command('ask'), command('help')] }]);
    const implementation = fixture.bot.setMyCommands;
    fixture.bot.setMyCommands = async (commands, options) => options.scope.type === failingScope
      ? false : implementation(commands, options);
    await assert.rejects(ensureOwnerEphemeralCommands(fixture.bot, -100, 999, ''), /did not confirm/);
    fixture.bot.setMyCommands = implementation;
    assert.equal(await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, ''), true);
    assertOwnerCommands(fixture.state.get(scopeKey(ownerScope())));
  }
});

test('does not remove unrelated owner commands to fit Telegram menu limit', async () => {
  const original = Array.from({ length: 100 }, (_, index) => command(`cmd${index}`));
  const fixture = fakeBot([{ scope: ownerScope(), commands: original }]);
  await assert.rejects(ensureOwnerEphemeralCommands(fixture.bot, -100, 999, ''), /without removing existing commands/);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.deletes.length, 0);
  assert.deepEqual(fixture.state.get(scopeKey(ownerScope())), original);
});

test('preserves Russian inheritance before neutral owner writes and cleanup change menu fallbacks', async () => {
  const neutral = [command('help'), command('ask')];
  const russian = [{ command: 'rules', description: 'Правила группы' }, command('say')];
  const chatScope = { type: 'chat', chat_id: -100 };
  const fixture = fakeBot([
    { scope: chatScope, commands: neutral },
    { scope: chatScope, language: 'ru', commands: russian },
  ]);
  await ensureOwnerEphemeralCommands(fixture.bot, -100, 999);
  assert.deepEqual(fixture.state.get(scopeKey(ownerScope()))[0], neutral[0]);
  assert.deepEqual(fixture.state.get(scopeKey(ownerScope(), 'ru'))[0], russian[0]);
  assert.deepEqual(fixture.state.get(scopeKey(chatScope)), [neutral[0]]);
  assert.deepEqual(fixture.state.get(scopeKey(chatScope, 'ru')), [russian[0]]);
  const writesAfterSuccess = fixture.writes.length;
  await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, 'RU');
  assert.equal(fixture.writes.length, writesAfterSuccess);
  await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, 'en-US');
  assertOwnerCommands(fixture.state.get(scopeKey(ownerScope(), 'en')));
  const writesAfterEnglish = fixture.writes.length;
  await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, 'invalid');
  assert.equal(fixture.writes.length, writesAfterEnglish);
});

test('retries only the failed owner language after a partially successful operation', async () => {
  const fixture = fakeBot();
  const implementation = fixture.bot.setMyCommands;
  let failRussian = true;
  const attempts = [];
  fixture.bot.setMyCommands = async (commands, options) => {
    if (options.scope.type === 'chat_member') {
      attempts.push(options.language_code);
      if (options.language_code === 'ru' && failRussian) throw new Error('Russian registration failure');
    }
    return implementation(commands, options);
  };
  await assert.rejects(ensureOwnerEphemeralCommands(fixture.bot, -100, 999), /Russian registration failure/);
  failRussian = false;
  await ensureOwnerEphemeralCommands(fixture.bot, -100, 999);
  assert.deepEqual(attempts, ['', 'ru', 'ru']);
});

test('skips inaccessible historical public scopes without rewriting their menus', async () => {
  const fixture = fakeBot();
  const implementation = fixture.bot.getMyCommands;
  fixture.bot.getMyCommands = async options => {
    if (options.scope.type === 'chat_administrators') {
      const error = new Error('Bad Request: chat not found');
      error.response = { body: { error_code: 400 } };
      throw error;
    }
    return implementation(options);
  };
  await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, '');
  assert.ok(!fixture.writes.some(write => write.options.scope.type === 'chat_administrators'));
  assertOwnerCommands(fixture.state.get(scopeKey(ownerScope())));
});

test('rejects private chat or invalid owner IDs before API calls', async () => {
  const fixture = fakeBot();
  for (const [chat, owner] of [[100, 999], [-100, 0], [-100, 'owner'], ['group', 999]]) {
    await assert.rejects(ensureOwnerEphemeralCommands(fixture.bot, chat, owner), /group chat ID and owner/);
  }
  assert.deepEqual(fixture.reads, []);
  assert.deepEqual(fixture.writes, []);
});

test('preserves inherited administrator menus only when the owner is an administrator', async () => {
  for (const type of ['chat_administrators', 'all_chat_administrators']) {
    for (const status of ['creator', 'administrator', 'member']) {
      const adminCommand = { command: 'admin_status', description: 'Existing admin command' };
      const help = command('help');
      const scope = type === 'chat_administrators' ? { type, chat_id: -100 } : { type };
      const fixture = fakeBot([{ scope, commands: [adminCommand] }, { scope: { type: 'default' }, commands: [help] }]);
      fixture.bot.getChatMember = async (chat, user) => {
        assert.equal(chat, -100);
        assert.equal(user, 999);
        return { status };
      };
      await ensureOwnerEphemeralCommands(fixture.bot, -100, 999, '');
      assert.deepEqual(fixture.state.get(scopeKey(ownerScope()))[0], status === 'member' ? help : adminCommand);
    }
  }
});
