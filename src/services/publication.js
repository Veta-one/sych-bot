function publicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function createPublication(bot, msg, target = null) {
  const chatId = msg.chat?.id;
  if (!['group', 'supergroup'].includes(msg.chat?.type)
    || !Number.isSafeInteger(msg.chat.id) || msg.chat.id >= 0) {
    throw publicationError('PUBLICATION_INVALID_CHAT');
  }
  const source = msg.reply_to_message;
  if (source && (source.ephemeral_message_id !== undefined
    || !Number.isSafeInteger(source.message_id) || source.message_id <= 0)) {
    throw publicationError('PUBLICATION_INVALID_REPLY');
  }
  const options = { link_preview_options: { is_disabled: true } };
  const threadId = msg.message_thread_id || source?.message_thread_id;
  if (threadId !== undefined && threadId !== null) {
    if (!Number.isSafeInteger(threadId) || threadId <= 0) throw publicationError('PUBLICATION_INVALID_TOPIC');
    options.message_thread_id = threadId;
  }
  if (source) options.reply_parameters = { message_id: source.message_id, allow_sending_without_reply: false };

  let label;
  let user;
  if (target) {
    const username = /^[a-z0-9_]{1,32}$/i.test(target.username || '') ? target.username : null;
    if (target.id !== undefined) {
      if (!Number.isSafeInteger(target.id) || target.id <= 0 || target.is_bot) {
        throw publicationError('PUBLICATION_INVALID_TARGET');
      }
      user = { id: target.id, is_bot: false, first_name: String(target.first_name || username || 'Участник') };
      if (username) user.username = username;
    } else if (!username) {
      throw publicationError('PUBLICATION_INVALID_TARGET');
    }
    label = username ? `@${username}` : user.first_name;
  }

  return {
    async send(answer) {
      if (typeof answer !== 'string' || !answer.trim()) throw publicationError('PUBLICATION_EMPTY');
      let text = answer.trim();
      const entities = [];
      if (label) {
        const placeholder = '{{recipient}}';
        let offset = text.indexOf(placeholder);
        if (offset >= 0) text = text.split(placeholder).join(label);
        else {
          offset = text.indexOf(label);
          if (offset < 0) { text = `${label}, ${text}`; offset = 0; }
        }
        entities.push(user ? { type: 'text_mention', offset, length: label.length, user }
          : { type: 'mention', offset, length: label.length });
      }
      if (text.includes('{{recipient}}')) throw publicationError('PUBLICATION_INVALID_TARGET');
      if (text.length > 4096) throw publicationError('PUBLICATION_TOO_LONG');
      let sent;
      try {
        // One attempt: an ambiguous network failure may already have delivered
        // the public message. Retrying or falling back could post it twice.
        sent = await bot.sendMessage(chatId, text, { ...options, ...(entities.length ? { entities } : {}) });
      } catch (_) {
        throw publicationError('PUBLICATION_UNCONFIRMED');
      }
      if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0) {
        throw publicationError('PUBLICATION_UNCONFIRMED');
      }
      return { messageId: sent.message_id, text };
    },
  };
}

module.exports = { createPublication };
