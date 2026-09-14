const botIdentities = new WeakMap();

// Telegram usernames are case-insensitive. Resolve the actual bot identity so
// another installation (or a renamed bot) does not accept Siitch_bot's commands.
async function resolveAddressedCommand(bot, text) {
  const match = String(text).trimStart().match(/^\/([a-z0-9_]+)@([a-z0-9_]+)(?=\s|$)/i);
  if (!match) return null;

  if (!botIdentities.has(bot)) {
    const identity = Promise.resolve().then(() => bot.getMe());
    botIdentities.set(bot, identity);
    identity.catch(() => botIdentities.delete(bot));
  }

  const me = await botIdentities.get(bot);
  if (!me.username || match[2].toLowerCase() !== me.username.toLowerCase()) return null;

  return { name: `/${match[1].toLowerCase()}`, username: me.username };
}

module.exports = { resolveAddressedCommand };
