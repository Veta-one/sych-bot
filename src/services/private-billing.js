const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { atomicWriteJsonSync } = require('./storage');

const FREE_REPLIES = 10;
const PACKAGE_REPLIES = 100;
const PACKAGE_STARS = 50;
const INVOICE_TTL = 30 * 60 * 1000;
const RECENT_REPLIES = 32;
const MAX_PENDING = 100;
const TERMS = 'В пилоте отвечаю на текст. Первые 10 ответов бесплатны.\n\n100 ответов стоят 50 ⭐. Это разовая покупка. Ответ с обычным поиском расходует один ответ из пакета. Остаток сохраняется, его можно посмотреть через /balance. Если ответ не пришёл, он не списывается. Вопросы по оплате и возвратам: /paysupport.';
const BUY_CALLBACK = 'sych-buy:';
const EMPTY_ACCOUNT = { freeUsed: 0, charges: [], replied: [] };

function readLedger(file) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, accounts: {}, orders: {}, charges: {} };
    throw error;
  }
  const ledger = JSON.parse(contents);
  const isMap = value => value && typeof value === 'object' && !Array.isArray(value);
  if (ledger?.version !== 1 || !isMap(ledger.accounts) || !isMap(ledger.orders) || !isMap(ledger.charges)) {
    throw new Error('Invalid private billing ledger');
  }
  return ledger;
}

function matchesPackage(payment) {
  return payment?.currency === 'XTR' && payment.total_amount === PACKAGE_STARS
    && /^sych-chat-v1-[a-f0-9]{32}$/.test(payment.invoice_payload ?? '');
}

function createPrivateBilling({ bot, file, processChat, sendHelp, forwardFree, isBanned, botUsername, support, supportUrl }) {
  let ledger;
  const queues = new Map();
  const pending = new Map();
  const offers = new Map();

  function getLedger() {
    ledger ??= readLedger(file);
    return ledger;
  }

  function commit(edit) {
    const next = structuredClone(getLedger());
    edit(next);
    atomicWriteJsonSync(file, next);
    ledger = next;
  }

  function getAccount(userId) {
    return getLedger().accounts[userId] ?? EMPTY_ACCOUNT;
  }

  function accountForEdit(next, userId) {
    return next.accounts[userId] ??= structuredClone(EMPTY_ACCOUNT);
  }

  function serialize(userId, action) {
    const next = (queues.get(userId) ?? Promise.resolve()).catch(() => {}).then(action);
    queues.set(userId, next);
    return next.finally(() => {
      if (queues.get(userId) === next) queues.delete(userId);
    });
  }

  function balance(userId) {
    const account = getAccount(userId);
    const free = Math.max(0, FREE_REPLIES - account.freeUsed);
    const paid = account.charges.reduce((sum, key) => sum + getLedger().charges[key].remaining, 0);
    return { free, paid };
  }

  function balanceText(userId) {
    const { free, paid } = balance(userId);
    return 'Осталось бесплатных ответов: ' + free + '.\nОтветов из пакетов: ' + paid + '.';
  }

  function remember(map, userId, entry) {
    map.delete(userId);
    if (map.size >= MAX_PENDING) map.delete(map.keys().next().value);
    map.set(userId, { ...entry, expires: Date.now() + INVOICE_TTL });
  }

  function sendInvoice(userId) {
    const now = Date.now();
    const existing = Object.entries(getLedger().orders).find(([, order]) =>
      order.userId === userId && !order.checkoutId && order.expires > now);
    const payload = existing?.[0] ?? 'sych-chat-v1-' + randomBytes(16).toString('hex');
    if (!existing) {
      commit(next => {
        for (const [key, order] of Object.entries(next.orders)) {
          if (!order.checkoutId && order.expires <= now) delete next.orders[key];
        }
        next.orders[payload] = { userId, expires: now + INVOICE_TTL };
      });
    }
    return bot.sendInvoice(userId, '100 ответов Сыча', 'Пакет для личного чата. Разовая покупка, без автопродления.',
      payload, '', 'XTR', [{ label: '100 ответов', amount: PACKAGE_STARS }], { start_parameter: 'private-chat' });
  }

  function hasPurchased(userId) {
    return getAccount(userId).charges.length > 0;
  }

  async function handlePreCheckout(query, enabled = true) {
    if (!query?.id) return;
    let ok = false;
    try {
      const userId = query.from?.id;
      const order = enabled && matchesPackage(query) && getLedger().orders[query.invoice_payload];
      if (order && Number.isSafeInteger(userId) && order.userId === userId && !order.chargeKey
        && !isBanned(userId)
        && (order.checkoutId === query.id || (!order.checkoutId && order.expires > Date.now()))) {
        if (!order.checkoutId) {
          commit(next => { next.orders[query.invoice_payload].checkoutId = query.id; });
        }
        ok = true;
      }
    } catch (error) {
      console.error('[PRIVATE BILLING] Checkout could not be recorded:', error.code ?? error.name);
    }
    return bot.answerPreCheckoutQuery(query.id, ok, ok ? {} : {
      error_message: enabled ? 'Этот счёт больше недоступен. Запроси новый через /buy.' : 'Покупки временно недоступны.'
    });
  }

  function recordPayment(userId, payment, refunded) {
    if (!matchesPackage(payment) || payment.is_recurring || payment.is_first_recurring
      || typeof payment.telegram_payment_charge_id !== 'string'
      || !payment.telegram_payment_charge_id || payment.telegram_payment_charge_id.length > 256) return false;
    const { orders, charges } = getLedger();
    const order = orders[payment.invoice_payload];
    const key = 'charge:' + payment.telegram_payment_charge_id;
    if (!order?.checkoutId || order.userId !== userId || (order.chargeKey && order.chargeKey !== key)) return false;
    const charge = charges[key];
    if (charge && (charge.payload !== payment.invoice_payload || !refunded || charge.refunded)) return false;

    commit(next => {
      next.orders[payment.invoice_payload].chargeKey = key;
      const account = accountForEdit(next, userId);
      if (!charge) account.charges.push(key);
      next.charges[key] = { payload: payment.invoice_payload, remaining: refunded ? 0 : PACKAGE_REPLIES, refunded };
    });
    return true;
  }

  async function answer(userId, msg) {
    const account = getAccount(userId);
    if (account.replied.includes(msg.message_id)) return;
    const paidCharge = account.freeUsed >= FREE_REPLIES
      ? account.charges.find(key => getLedger().charges[key].remaining > 0)
      : undefined;
    if (!paidCharge && account.freeUsed >= FREE_REPLIES) {
      if (msg.text || msg.caption) remember(pending, userId, { msg });
      return bot.sendMessage(userId, 'Ответы закончились. Пополнить запас можно через /buy. ' + balanceText(userId));
    }

    if (!getAccount(userId).charges.length) {
      try {
        await forwardFree(msg);
      } catch {
        console.error('[PRIVATE BILLING] Could not forward a free request');
      }
    }
    if (await processChat(msg) !== true) return;
    commit(next => {
      const current = accountForEdit(next, userId);
      if (paidCharge) {
        const charge = next.charges[paidCharge];
        if (charge.remaining > 0) charge.remaining -= 1;
      } else {
        current.freeUsed += 1;
      }
      current.replied.push(msg.message_id);
      if (current.replied.length > RECENT_REPLIES) current.replied.shift();
    });
    if (!paidCharge && getAccount(userId).freeUsed === FREE_REPLIES && !getAccount(userId).charges.length) {
      await bot.sendMessage(userId, 'Бесплатные ответы закончились. Пакет из 100 ответов стоит 50 ⭐. Открыть покупку: /buy.');
    }
  }

  async function handleConversation(userId, msg) {
    const command = /^(\/[a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(msg.text?.trim() ?? '');
    if (command?.[2]) {
      const username = typeof botUsername === 'function' ? await botUsername() : botUsername;
      if (command[2].toLowerCase() !== username?.toLowerCase()) return;
    }
    const name = command?.[1].toLowerCase();
    const args = command?.[3]?.trim();
    if (name === '/paysupport') {
      if (args && support) {
        await support(msg, args.slice(0, 3000));
        return bot.sendMessage(userId, 'Передал обращение по оплате владельцу Сыча.');
      }
      if (supportUrl) return bot.sendMessage(userId, 'Поддержка по оплате: ' + supportUrl);
      return bot.sendMessage(userId, support
        ? 'Напиши /paysupport и через пробел опиши проблему. Я передам владельцу только это обращение.'
        : 'Поддержка по оплате временно недоступна. Попробуй позже.');
    }
    if (name === '/terms') return bot.sendMessage(userId, TERMS);
    if (isBanned(userId)) return;
    if (name === '/balance') return bot.sendMessage(userId, balanceText(userId) + '\nПакет из 100 ответов за 50 ⭐: /buy.');
    if (name === '/buy') {
      const data = BUY_CALLBACK + randomBytes(12).toString('hex');
      remember(offers, userId, { data });
      return bot.sendMessage(userId, TERMS, {
        reply_markup: { inline_keyboard: [[{ text: 'Купить за 50 ⭐', callback_data: data }]] }
      });
    }
    if (name === '/help') return sendHelp(userId, {
      ...balance(userId), trialSize: FREE_REPLIES, packageSize: PACKAGE_REPLIES, packagePrice: PACKAGE_STARS
    });
    if (name === '/start') {
      return bot.sendMessage(userId, 'Я Сыч. Напиши вопрос или продолжи разговор обычным сообщением.\n\n' + balanceText(userId)
        + '\nУсловия: /terms. Пополнить баланс: /buy. Поддержка по оплате: /paysupport.');
    }
    if (name === '/forget_me') {
      pending.delete(userId);
      return processChat(msg);
    }
    if (name) return bot.sendMessage(userId, 'В личке можно просто написать вопрос. Доступные команды: /help.');
    return answer(userId, msg);
  }

  async function handleBuyCallback(query, enabled = true) {
    if (!query?.data?.startsWith(BUY_CALLBACK)) return;
    const userId = query.from?.id;
    if (!Number.isSafeInteger(userId) || query.message?.chat?.type !== 'private'
      || query.message.chat.id !== userId) {
      return bot.answerCallbackQuery(query.id, { text: 'Открой покупку в личке через /buy.' });
    }
    const offer = offers.get(userId);
    if (!enabled || isBanned(userId) || offer?.data !== query.data || offer.expires <= Date.now()) {
      return bot.answerCallbackQuery(query.id, { text: 'Кнопка устарела. Открой новый счёт через /buy.' });
    }
    offers.delete(userId);
    await bot.answerCallbackQuery(query.id);
    return sendInvoice(userId);
  }

  function handleMessage(msg, enabled = true) {
    const userId = msg?.chat?.id;
    if (msg?.chat?.type !== 'private' || !Number.isSafeInteger(userId) || userId <= 0 || msg.business_connection_id) return;
    // Telegram advances the polling offset without awaiting the listener. Persist
    // payment service updates before awaiting sends or queued conversations.
    if (msg.refunded_payment) {
      recordPayment(userId, msg.refunded_payment, true);
      return;
    }
    if (msg.from?.id !== userId || msg.from?.is_bot) return;
    if (msg.successful_payment) {
      if (!recordPayment(userId, msg.successful_payment, false)) return;
      const waiting = pending.get(userId);
      pending.delete(userId);
      return serialize(userId, async () => {
        try {
          await bot.sendMessage(userId, 'Оплата прошла. Добавил 100 ответов.\n\n' + balanceText(userId));
        } finally {
          if (enabled && !isBanned(userId) && waiting?.expires > Date.now()) await answer(userId, waiting.msg);
        }
      });
    }
    if (enabled) return serialize(userId, () => handleConversation(userId, msg));
  }

  return { handleMessage, handleBuyCallback, handlePreCheckout, hasPurchased };
}

module.exports = { createPrivateBilling };
