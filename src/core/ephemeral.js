const { withTimeout } = require('../utils/async');
const { runPrivateWork } = require('../utils/private-context');

const PRIVATE_TTL_MS = 30 * 60 * 1000;
const MAX_PRIVATE_DIALOGS = 64;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

function isEphemeralMessage(msg) {
  return msg?.ephemeral_message_id !== undefined;
}

function createEphemeralHandler({ config, storage, ai, sendRich, download, getPublicHistory,
  now = Date.now, answerTimeoutMs = 120000 }) {
  const dialogs = new Map();
  const inFlight = new Set();
  const identities = new WeakMap();
  const revisions = new Map();

  const threadFor = msg => msg.message_thread_id || msg.reply_to_message?.message_thread_id || 0;
  const keyFor = (msg, answerId) => `${msg.chat.id}:${msg.from.id}:${threadFor(msg)}:${answerId}`;
  const prune = () => {
    for (const [key, value] of dialogs) if (now() - value.updated >= PRIVATE_TTL_MS) dialogs.delete(key);
    while (dialogs.size > MAX_PRIVATE_DIALOGS) dialogs.delete(dialogs.keys().next().value);
  };

  async function readMedia(bot, message, label) {
    if (!message) return null;
    const photo = message.photo?.at(-1);
    const imageDocument = message.document?.mime_type?.startsWith('image/') ? message.document : null;
    const sticker = message.sticker && !message.sticker.is_animated && !message.sticker.is_video ? message.sticker : null;
    const media = photo || imageDocument || sticker;
    let url;
    let mimeType = imageDocument?.mime_type || (sticker ? 'image/webp' : 'image/jpeg');
    if (media) {
      if (media.file_size > MAX_MEDIA_BYTES) throw new Error('MEDIA_TOO_LARGE');
      url = await bot.getFileLink(media.file_id);
    } else {
      const text = message.text || message.caption || '';
      const match = text.match(/https?:\/\/[^\s<>]+\.(?:jpg|jpeg|png|webp|gif|bmp)(?:\?[^\s<>]*)?/i);
      if (!match) return null;
      url = match[0];
      const extension = new URL(url).pathname.split('.').pop().toLowerCase();
      mimeType = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
    }
    const result = await download(url);
    const buffer = Buffer.isBuffer(result) ? result : Buffer.from(result.data);
    if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) throw new Error('MEDIA_TOO_LARGE');
    return { buffer, mimeType, label };
  }

  const handle = async function handle(bot, msg) {
    if (!isEphemeralMessage(msg)) return false;
    // Never allow an ephemeral input to fall through to public state or delivery.
    if (!['group', 'supergroup'].includes(msg.chat?.type) || msg.message_id !== 0
      || !Number.isSafeInteger(msg.ephemeral_message_id) || msg.ephemeral_message_id === 0
      || !Number.isSafeInteger(msg.from?.id) || msg.from.id !== Number(config.adminId)) return true;

    const requestKey = `${msg.chat.id}:${msg.from.id}:${msg.ephemeral_message_id}:${msg.date || 0}`;
    if (inFlight.has(requestKey)) return true;
    inFlight.add(requestKey);
    const revision = revisions.get(String(msg.from.id)) || 0;
    const initialOptions = { threadId: threadFor(msg) || null,
      ephemeral: { receiverUserId: msg.from.id, replyToEphemeralId: msg.ephemeral_message_id } };
    let responseId;
    let responseDate;
    const reply = content => sendRich(bot, msg.chat.id, content, responseId
      ? { ephemeral: { receiverUserId: msg.from.id, editId: responseId } } : initialOptions);

    try {
      let text = msg.text || msg.caption || '';
      const match = text.trimStart().match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?=\s|$)/i);
      let command = match ? match[1].toLowerCase() : null;
      if (match?.[2]) {
        if (!identities.has(bot)) {
          const identity = Promise.resolve().then(() => bot.getMe());
          identities.set(bot, identity);
          identity.catch(() => identities.delete(bot));
        }
        const me = await identities.get(bot);
        if (match[2].toLowerCase() !== String(me.username || '').toLowerCase()) return true;
      }
      if (!command && msg.reply_to_message?.ephemeral_message_id
        && String(msg.reply_to_message.from?.id) === String(config.botId)) command = 'ask';
      if (!['ask', 'mute', 'ban'].includes(command)) {
        await reply({ markdown: 'Скрытые команды: /ask для вопроса, /mute для тишины, /ban реплаем для игнорирования участника.' });
        return true;
      }

      if (command === 'mute') {
        const muted = storage.toggleChatMute(msg.chat.id);
        storage.forceSave();
        await reply({ markdown: muted ? '🦉 Публично молчу во всём чате. Скрытые команды доступны. Повтори /mute, чтобы включить меня.'
          : '🦉 Публичные ответы снова включены. Муты отдельных тем сохраняются.' });
        return true;
      }
      if (command === 'ban') {
        const target = msg.reply_to_message?.from;
        if (!target?.id || target.is_bot || target.id === Number(config.adminId)
          || msg.reply_to_message?.sender_chat || !Number.isSafeInteger(target.id) || target.id <= 0) {
          await reply({ markdown: 'Отправь /ban реплаем на сообщение участника. Себя, ботов и анонимные сообщения не баню.' });
          return true;
        }
        storage.banUserInChat(msg.chat.id, target.id, target.username ? `@${target.username}` : target.first_name || 'Участник');
        storage.forceSave();
        await reply({ markdown: '🦉 Игнорирую этого участника в данном чате: не отвечаю, не реагирую и не расшифровываю его голосовые. В других чатах ничего не меняется.' });
        return true;
      }

      if (match) text = text.trimStart().slice(match[0].length).trim();
      const source = msg.reply_to_message;
      const sourceText = source?.text || source?.caption || '';
      prune();
      const continuation = Boolean(source?.ephemeral_message_id
        && String(source.from?.id) === String(config.botId));
      const cached = continuation ? dialogs.get(keyFor(msg, source.ephemeral_message_id)) : null;
      const previous = cached && Number.isSafeInteger(source.date) && source.date > 0
        && cached.messageDate === source.date ? cached.history : [];
      const hasImage = message => Boolean(message?.photo?.length
        || message?.document?.mime_type?.startsWith('image/')
        || (message?.sticker && !message.sticker.is_animated && !message.sticker.is_video));
      if (source && !sourceText && !hasImage(source) && !previous.length) {
        await reply({ markdown: 'Не вижу содержимое исходного сообщения или не могу прочитать этот формат. Пришли текст или изображение в скрытой команде.' });
        return true;
      }
      if (!text && !hasImage(msg) && !sourceText && !hasImage(source) && !previous.length) {
        await reply({ markdown: 'Напиши вопрос после /ask или добавь картинку. Можно реплаем на сообщение участника.' });
        return true;
      }
      const ack = await reply({ markdown: '🦉 Думаю…' });
      responseId = ack.ephemeralMessageId;
      responseDate = ack.messageDate;
      if (!Number.isSafeInteger(responseId) || responseId === 0) throw new Error('MISSING_EPHEMERAL_ID');
      const images = (await Promise.all([
        readMedia(bot, { ...msg, text, caption: text }, 'Изображение из твоего запроса'),
        readMedia(bot, source, 'Изображение сообщения, на которое ты ответил'),
      ])).filter(Boolean);
      const publicHistory = (getPublicHistory(msg.chat.id) || []).slice(-20).map(entry => ({ ...entry }));
      const input = { sender: msg.from.first_name || 'Владелец', text: text || 'Разбери сообщение или изображение, на которое я ответил.', replyText: sourceText };
      const sourceUrl = sourceText.match(/https?:\/\/[^\s)]+/)?.[0];
      if (sourceUrl && !/https?:\/\//.test(input.text)) input.text += `\nСсылка в исходном сообщении: ${sourceUrl}`;
      const answer = await runPrivateWork(() => withTimeout(ai.getResponse(
        [...publicHistory, ...previous], input, images.length ? images : null, 'image/jpeg',
        storage.getUserInstruction(msg.from.username || ''), storage.getProfile(msg.chat.id, msg.from.id),
        false, storage.getChatProfile(msg.chat.id), ''), answerTimeoutMs, 'Private answer'));
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('EMPTY_PRIVATE_ANSWER');
      await reply({ markdown: answer });
      const history = [...previous, { role: input.sender, text: [sourceText, input.text].filter(Boolean).join('\n') },
        { role: 'Сыч', text: answer }].slice(-20);
      const dialogKey = keyFor(msg, responseId);
      if (Number.isSafeInteger(responseDate) && responseDate > 0
        && revision === (revisions.get(String(msg.from.id)) || 0)) {
        dialogs.delete(dialogKey);
        dialogs.set(dialogKey, { history, messageDate: responseDate, userId: String(msg.from.id), updated: now() });
      }
      prune();
    } catch (_) {
      // Do not put Axios/model errors (URLs, tokens, prompts) in logs or another chat.
      if (responseId) await reply({ markdown: 'Не удалось подготовить или доставить скрытый ответ. Попробуй ещё раз.' }).catch(() => {});
      console.error('[EPHEMERAL] Private request did not complete.');
    } finally {
      inFlight.delete(requestKey);
    }
    return true;
  };
  handle.forgetUser = userId => {
    const id = String(userId);
    revisions.set(id, (revisions.get(id) || 0) + 1);
    for (const [key, dialog] of dialogs) if (dialog.userId === id) dialogs.delete(key);
  };
  return handle;
}

module.exports = { createEphemeralHandler, isEphemeralMessage };
