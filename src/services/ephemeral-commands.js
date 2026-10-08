const registrations = new WeakMap();
const publicCleanups = new WeakMap();

const ownerCommands = [
  { command: 'ask', description: 'Спросить Сыча скрытно, можно реплаем с фото или ссылкой', is_ephemeral: true },
  { command: 'say', description: 'Скрытно попросить Сыча написать в общий чат', is_ephemeral: true },
  { command: 'mute', description: 'Выключить или включить Сыча в этом чате', is_ephemeral: true },
  { command: 'ban', description: 'Реплаем запретить Сычу отвечать участнику в этом чате', is_ephemeral: true },
];
const ownerCommandNames = new Set(ownerCommands.map(command => command.command));

function isInaccessibleScope(error) {
  return Number(error.response?.body?.error_code || error.response?.data?.error_code
    || error.response?.statusCode || error.response?.status || error.statusCode) === 400;
}

async function readCommands(bot, scope, language, allowInaccessible = false) {
  let commands;
  try {
    commands = await bot.getMyCommands({ scope: { ...scope }, language_code: language });
  } catch (error) {
    // Historical chats may no longer be accessible. Never rewrite a scope
    // whose command list could not be read; other chat scopes can still work.
    if (allowInaccessible && isInaccessibleScope(error)) return null;
    throw error;
  }
  if (!Array.isArray(commands)) throw new Error('Telegram returned an invalid command list');
  return commands;
}

function cleanupPublicScope(bot, scope, language) {
  let cache = publicCleanups.get(bot);
  if (!cache) {
    cache = new Map();
    publicCleanups.set(bot, cache);
  }
  const key = `${scope.type}:${scope.chat_id || ''}:${language}`;
  if (cache.has(key)) return cache.get(key);
  const cleanup = Promise.resolve().then(async () => {
    const commands = await readCommands(bot, scope, language, true);
    if (!commands) return true;
    const preserved = commands.filter(command => !ownerCommandNames.has(command.command));
    if (preserved.length === commands.length) return true;
    const options = { scope: { ...scope }, language_code: language };
    const result = preserved.length === 0 && typeof bot.deleteMyCommands === 'function'
      ? await bot.deleteMyCommands(options)
      : await bot.setMyCommands(preserved, options);
    if (result !== true) throw new Error('Telegram did not confirm public command cleanup');
    return true;
  }).catch(error => {
    if (cache.get(key) === cleanup) cache.delete(key);
    throw error;
  });
  cache.set(key, cleanup);
  return cleanup;
}

async function cleanupPublicMenus(bot, chatId, languages) {
  const scopes = [
    { type: 'default' },
    { type: 'all_private_chats' },
    { type: 'all_group_chats' },
    { type: 'all_chat_administrators' },
    { type: 'chat', chat_id: chatId },
    { type: 'chat_administrators', chat_id: chatId },
  ];
  for (const scope of scopes) {
    for (const language of languages) await cleanupPublicScope(bot, scope, language);
  }
}

async function readExistingCommands(bot, scope, chatId, languageCode, isAdministrator) {
  // A specific menu masks broader ones in Telegram. Preserve its commands;
  // when no owner menu exists, inherit the first applicable group menu.
  for (const candidate of [
    scope,
    ...(isAdministrator ? [{ type: 'chat_administrators', chat_id: chatId }] : []),
    { type: 'chat', chat_id: chatId },
    ...(isAdministrator ? [{ type: 'all_chat_administrators' }] : []),
    { type: 'all_group_chats' },
    { type: 'default' },
  ]) {
    for (const language of languageCode ? [languageCode, ''] : ['']) {
      const commands = await readCommands(bot, candidate, language, candidate.type !== 'chat_member');
      if (commands?.length) return commands;
    }
  }
  return [];
}

async function ensureOwnerEphemeralCommands(bot, chatId, adminId, languageCode = 'ru') {
  if (!Number.isSafeInteger(Number(chatId)) || Number(chatId) >= 0
      || !Number.isSafeInteger(Number(adminId)) || Number(adminId) <= 0) {
    throw new TypeError('A group chat ID and owner user ID are required');
  }

  let botRegistrations = registrations.get(bot);
  if (!botRegistrations) {
    botRegistrations = new Map();
    registrations.set(bot, botRegistrations);
  }
  const scope = { type: 'chat_member', chat_id: chatId, user_id: adminId };
  const languageMatch = String(languageCode || '').match(/^([a-z]{2})(?:-[a-z0-9-]+)?$/i);
  const languages = languageMatch ? ['', languageMatch[1].toLowerCase()] : [''];
  const keyFor = language => `${Number(chatId)}:${Number(adminId)}:${language}`;
  const missing = languages.filter(language => !botRegistrations.has(keyFor(language)));

  if (missing.length) {
    // Read all inherited menus before writing any: a new neutral owner menu
    // would otherwise mask an existing language-specific group menu.
    const registration = Promise.resolve().then(async () => {
      const member = typeof bot.getChatMember === 'function' ? await bot.getChatMember(chatId, adminId) : null;
      const isAdministrator = ['creator', 'administrator'].includes(member?.status);
      const menus = await Promise.all(missing.map(language => readExistingCommands(bot, scope, chatId, language, isAdministrator)));
      const commandLists = menus.map(existing => {
        const preserved = existing.filter(command => !ownerCommandNames.has(command.command));
        const commands = [...preserved, ...ownerCommands.map(command => ({ ...command }))];
        if (commands.length > 100) {
          throw new Error('Cannot add owner commands without removing existing commands: Telegram limit is 100');
        }
        return commands;
      });
      // Register only the owner's menu after removing these names from shared
      // menus. Read the owner's original inheritance before changing any menu.
      await cleanupPublicMenus(bot, chatId, languages);
      for (let index = 0; index < missing.length; index++) {
        const language = missing[index];
        const result = await bot.setMyCommands(commandLists[index], { scope: { ...scope }, language_code: language });
        if (result !== true) throw new Error('Telegram did not confirm owner command registration');
        botRegistrations.set(keyFor(language), Promise.resolve(true));
      }
      return true;
    }).catch(error => {
      // Preserve successful neutral/language registrations if a later one fails.
      for (const language of missing) {
        if (botRegistrations.get(keyFor(language)) === registration) botRegistrations.delete(keyFor(language));
      }
      throw error;
    });
    for (const language of missing) botRegistrations.set(keyFor(language), registration);
  }
  await Promise.all(languages.map(language => botRegistrations.get(keyFor(language))));
  // An owner registration may already be cached while another language/chat
  // cleanup failed. Retry that cleanup without rewriting successful menus.
  await cleanupPublicMenus(bot, chatId, languages);
  return true;
}

module.exports = { ensureOwnerEphemeralCommands };
