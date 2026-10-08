const assert = require('node:assert/strict');
const test = require('node:test');
const { ensureOwnerEphemeralCommands } = require('../src/services/ephemeral-commands');

function fakeBot(menus = {}) {
  const reads = [];
  const writes = [];
  const bot = {
    getMyCommands: async options => {
      reads.push(options);
      return menus[options.scope.type] || [];
    },
    setMyCommands: async (commands, options) => {
      writes.push({ commands, options });
      return true;
    },
  };
  return { bot, reads, writes };
}

test('registers three ephemeral commands only in the owner menu while preserving other commands', async () => {
  const help = { command: 'help', description: 'Помощь', is_ephemeral: false };
  const status = { command: 'status', description: 'Состояние', is_ephemeral: true };
  const original = [
    help,
    { command: 'ask', description: 'Old', is_ephemeral: false },
    { command: 'mute', description: 'Old' },
    { command: 'ban', description: 'Old', is_ephemeral: false },
    { command: 'ask', description: 'Duplicate' },
    status,
  ];
  const { bot, reads, writes } = fakeBot({ chat_member: original });
  assert.equal(await ensureOwnerEphemeralCommands(bot, -100123, 999, ''), true);
  const scope = { type: 'chat_member', chat_id: -100123, user_id: 999 };
  assert.deepEqual(reads, [{ scope, language_code: '' }]);
  assert.deepEqual(writes[0].options, { scope, language_code: '' });
  assert.deepEqual(writes[0].commands.slice(0, 2), [help, status]);
  assert.deepEqual(writes[0].commands.slice(2).map(command => command.command), ['ask', 'mute', 'ban']);
  for (const command of writes[0].commands.slice(2)) {
    assert.equal(command.is_ephemeral, true);
    assert.match(command.description, /[а-яё]/i);
  }
  assert.equal(original.length, 6);
  assert.equal(original[1].is_ephemeral, false);
});

test('inherits the first applicable fallback menu without changing public menus', async () => {
  for (const source of ['chat', 'all_group_chats', 'default']) {
    const help = { command: 'help', description: `From ${source}` };
    const menus = { [source]: [help] };
    if (source !== 'default') menus.default = [{ command: 'version', description: 'Default' }];
    const { bot, reads, writes } = fakeBot(menus);
    await ensureOwnerEphemeralCommands(bot, -100, 999, '');
    const expectedOrder = ['chat_member', 'chat', 'all_group_chats', 'default'];
    assert.deepEqual(reads.map(read => read.scope.type), expectedOrder.slice(0, expectedOrder.indexOf(source) + 1));
    assert.deepEqual(writes[0].commands[0], help);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].options.scope.type, 'chat_member');
  }
});

test('deduplicates simultaneous registration and caches success per bot, chat and owner', async () => {
  const { bot, reads, writes } = fakeBot();
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureOwnerEphemeralCommands(bot, -100, 999)));
  assert.ok(results.every(Boolean));
  assert.equal(writes.length, 2);
  assert.equal(reads.length, 12);
  await ensureOwnerEphemeralCommands(bot, '-100', '999');
  assert.equal(writes.length, 2);
  await ensureOwnerEphemeralCommands(bot, -101, 999);
  await ensureOwnerEphemeralCommands(bot, -100, 998);
  assert.equal(writes.length, 6);
  const other = fakeBot();
  await ensureOwnerEphemeralCommands(other.bot, -100, 999);
  assert.equal(other.writes.length, 2);
});

test('allows retry after failed reads or writes and shares concurrent failure', async () => {
  for (const phase of ['read', 'write']) {
    const { bot, writes } = fakeBot();
    const method = phase === 'read' ? 'getMyCommands' : 'setMyCommands';
    const implementation = bot[method];
    let calls = 0;
    bot[method] = async (...args) => {
      if (++calls === 1) throw new Error('temporary failure');
      return implementation(...args);
    };
    const results = await Promise.allSettled([
      ensureOwnerEphemeralCommands(bot, -100, 999, ''),
      ensureOwnerEphemeralCommands(bot, -100, 999, ''),
    ]);
    assert.ok(results.every(result => result.status === 'rejected' && /temporary failure/.test(result.reason.message)));
    assert.equal(calls, 1);
    assert.equal(await ensureOwnerEphemeralCommands(bot, -100, 999, ''), true);
    assert.equal(writes.length, 1);
  }
});

test('does not cache an unconfirmed registration or remove existing commands to fit the limit', async () => {
  const unconfirmed = fakeBot();
  unconfirmed.bot.setMyCommands = async () => false;
  await assert.rejects(ensureOwnerEphemeralCommands(unconfirmed.bot, -100, 999, ''), /did not confirm/);
  unconfirmed.bot.setMyCommands = async (commands, options) => {
    unconfirmed.writes.push({ commands, options });
    return true;
  };
  assert.equal(await ensureOwnerEphemeralCommands(unconfirmed.bot, -100, 999, ''), true);

  const full = fakeBot({ chat_member: Array.from({ length: 100 }, (_, index) => ({ command: `cmd${index}`, description: 'Keep' })) });
  await assert.rejects(ensureOwnerEphemeralCommands(full.bot, -100, 999, ''), /without removing existing commands/);
  assert.equal(full.writes.length, 0);
});

test('preserves Russian inherited commands before a new neutral owner menu masks them', async () => {
  const { bot, reads, writes } = fakeBot();
  const neutral = [{ command: 'help', description: 'Neutral help' }];
  const russian = [{ command: 'rules', description: 'Правила группы' }];
  const state = new Map([
    ['chat:', neutral],
    ['chat:ru', russian],
  ]);
  bot.getMyCommands = async options => {
    reads.push(options);
    return state.get(`${options.scope.type}:${options.language_code}`) || [];
  };
  bot.setMyCommands = async (commands, options) => {
    writes.push({ commands, options });
    state.set(`${options.scope.type}:${options.language_code}`, commands);
    return true;
  };
  await ensureOwnerEphemeralCommands(bot, -100, 999);
  assert.deepEqual(writes.map(write => write.options.language_code), ['', 'ru']);
  assert.deepEqual(writes[0].commands[0], neutral[0]);
  assert.deepEqual(writes[1].commands[0], russian[0]);
  await ensureOwnerEphemeralCommands(bot, -100, 999, 'RU');
  assert.equal(writes.length, 2);
  await ensureOwnerEphemeralCommands(bot, -100, 999, 'en-US');
  assert.equal(writes.length, 3);
  assert.equal(writes[2].options.language_code, 'en');
  await ensureOwnerEphemeralCommands(bot, -100, 999, 'invalid');
  assert.equal(writes.length, 3);
});

test('retries only the failed language registration after a partially successful operation', async () => {
  const { bot, writes } = fakeBot();
  let failRussian = true;
  bot.setMyCommands = async (commands, options) => {
    writes.push({ commands, options });
    if (options.language_code === 'ru' && failRussian) throw new Error('Russian registration failure');
    return true;
  };
  await assert.rejects(ensureOwnerEphemeralCommands(bot, -100, 999), /Russian registration failure/);
  failRussian = false;
  await ensureOwnerEphemeralCommands(bot, -100, 999);
  assert.deepEqual(writes.map(write => write.options.language_code), ['', 'ru', 'ru']);
});

test('rejects private chat or invalid owner IDs before API calls', async () => {
  const { bot, reads, writes } = fakeBot();
  for (const [chat, owner] of [[100, 999], [-100, 0], [-100, 'owner'], ['group', 999]]) {
    await assert.rejects(ensureOwnerEphemeralCommands(bot, chat, owner), /group chat ID and owner/);
  }
  assert.deepEqual(reads, []);
  assert.deepEqual(writes, []);
});

test('preserves inherited administrator menus only when the owner is an administrator', async () => {
  for (const source of ['chat_administrators', 'all_chat_administrators']) {
    for (const status of ['creator', 'administrator', 'member']) {
      const adminCommand = { command: 'admin_status', description: 'Existing admin command' };
      const help = { command: 'help', description: 'Help' };
      const { bot, writes } = fakeBot({ [source]: [adminCommand], default: [help] });
      bot.getChatMember = async (chat, user) => {
        assert.equal(chat, -100);
        assert.equal(user, 999);
        return { status };
      };
      await ensureOwnerEphemeralCommands(bot, -100, 999, '');
      assert.deepEqual(writes[0].commands[0], status === 'member' ? help : adminCommand);
    }
  }
});
