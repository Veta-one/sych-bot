const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createPrivateBilling } = require('../src/services/private-billing');

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sych-billing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'billing.json');
  const output = [];
  const forwarded = [];
  const handled = [];
  const bot = {
    sendMessage: async (...args) => output.push({ message: args }),
    sendInvoice: async (...args) => output.push({ invoice: args }),
    answerCallbackQuery: async (...args) => output.push({ callback: args }),
    answerPreCheckoutQuery: async (...args) => output.push({ checkout: args })
  };
  const billingOptions = {
    bot,
    file,
    botUsername: 'Sych_Test_Bot',
    isBanned: () => false,
    forwardFree: async msg => { forwarded.push(msg.message_id); },
    processChat: async msg => {
      handled.push(msg.message_id);
      return msg.text !== 'failed';
    },
    ...options
  };
  let billing = createPrivateBilling(billingOptions);
  let id = 0;
  const message = (text, userId = 42) => ({
    chat: { type: 'private', id: userId },
    from: { id: userId },
    message_id: ++id,
    text
  });
  const send = (text, userId) => billing.handleMessage(message(text, userId));
  const ledger = () => JSON.parse(readFileSync(file, 'utf8'));

  const tap = (data, userId = 42, chatId = userId) => billing.handleBuyCallback({
    id: 'tap', data, from: { id: userId }, message: { chat: { id: chatId, type: 'private' } }
  });

  async function invoice(userId = 42) {
    await send('/buy', userId);
    await tap(output.at(-1).message[2].reply_markup.inline_keyboard[0][0].callback_data, userId);
    const args = output.filter(o => o.invoice).at(-1).invoice;
    assert.deepEqual([args[0], ...args.slice(4, 7)], [userId, '', 'XTR', [{ label: '100 ответов', amount: 50 }]]);
    return args[3];
  }
  function payment(payload, charge = 'test-charge') {
    return { currency: 'XTR', total_amount: 50, invoice_payload: payload, telegram_payment_charge_id: charge };
  }
  function receipt(paymentInfo, field = 'successful_payment', userId = 42, enabled = true) {
    return billing.handleMessage({ ...message(undefined, userId), [field]: paymentInfo }, enabled);
  }
  function checkout(payload, userId = 42, query = 'query', amount = 50, enabled = true) {
    return billing.handlePreCheckout({ id: query, from: { id: userId }, ...payment(payload), total_amount: amount }, enabled);
  }

  return {
    file, output, forwarded, handled, message, send, ledger, invoice, payment, receipt, checkout,
    tap, handleMessage: msg => billing.handleMessage(msg),
    hasPurchased: id => billing.hasPurchased(id),
    restart: () => { billing = createPrivateBilling(billingOptions); }
  };
}

test('the trial counts ten successful replies and serializes simultaneous requests', async t => {
  const f = fixture(t);
  await f.send('/start');
  await f.send('/balance');
  await f.send('failed');
  await Promise.all(Array.from({ length: 11 }, () => f.send('question')));
  assert.equal(f.handled.length, 11);
  assert.deepEqual(f.forwarded, f.handled);
  assert.equal(f.ledger().accounts['42'].freeUsed, 10);
  assert.match(f.output.at(-1).message[1], /Ответы закончились/);
  f.restart();
  await f.send('/balance');
  assert.match(f.output.at(-1).message[1], /бесплатных ответов: 0/);
});

test('payment requires shown terms, a matching checkout, and grants a package only once', async t => {
  const f = fixture(t);
  await f.send('/buy confirm');
  assert.equal(f.output.some(o => o.invoice), false);
  const payload = await f.invoice();
  await f.checkout(payload, 43);
  await f.checkout(payload, 42, 'wrong-amount', 51);
  await f.receipt(f.payment(payload));
  assert.equal(f.ledger().accounts['42'], undefined);
  await f.checkout(payload);
  await f.checkout(payload, 42, 'second-checkout');
  assert.deepEqual(f.output.filter(o => o.checkout).map(o => o.checkout[1]), [false, false, true, false]);
  await f.receipt(f.payment(payload, 'other-user'), 'successful_payment', 43);
  assert.equal(f.ledger().accounts['43'], undefined);
  await f.receipt(f.payment(payload));
  f.restart();
  await f.receipt(f.payment(payload));
  await f.receipt(f.payment(payload, 'different-charge'));
  assert.equal(f.ledger().charges['charge:test-charge'].remaining, 100);
  assert.equal(f.ledger().accounts['42'].charges.length, 1);
  assert.equal(f.output.filter(o => o.message?.[1].includes('Оплата прошла')).length, 1);
});

test('payment resumes the waiting question once, only successful paid answers are debited', async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) await f.send('trial question');
  const waiting = f.message('waiting');
  await f.handleMessage(waiting);
  const payload = await f.invoice();
  await f.checkout(payload);
  await f.receipt(f.payment(payload));
  assert.equal(f.handled.at(-1), waiting.message_id);
  assert.equal(f.ledger().charges['charge:test-charge'].remaining, 99);
  await f.receipt(f.payment(payload));
  await f.handleMessage(waiting);
  await f.send('failed');
  assert.equal(f.ledger().charges['charge:test-charge'].remaining, 99);
  assert.equal(f.forwarded.length, 10);
  assert.equal(f.handled.filter(id => id === waiting.message_id).length, 1);
});

test('receipts are persisted even while a conversation waits for an answer', async t => {
  let release;
  let started;
  const begin = new Promise(resolve => { started = resolve; });
  const reply = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { processChat: async () => { started(); return reply; } });
  const payload = await f.invoice();
  await f.checkout(payload);
  const chatting = f.send('long question');
  await begin;
  const receipt = f.receipt(f.payment(payload));
  assert.equal(f.ledger().charges['charge:test-charge'].remaining, 100);
  release(true);
  await Promise.all([chatting, receipt]);
});

test('a refund delivered before its receipt keeps the account private across restarts', async t => {
  const f = fixture(t);
  const payload = await f.invoice();
  await f.checkout(payload);
  const payment = f.payment(payload);
  await f.receipt(payment, 'refunded_payment');
  await f.receipt(payment);
  f.restart();
  await f.send('private question');
  assert.equal(f.ledger().charges['charge:test-charge'].remaining, 0);
  assert.equal(f.ledger().charges['charge:test-charge'].refunded, true);
  assert.equal(f.handled.length, 1);
  assert.equal(f.forwarded.length, 0);
});

test('an unreadable ledger stops AI and forwarding and declines checkout', async t => {
  const f = fixture(t);
  writeFileSync(f.file, '{');
  await assert.rejects(f.send('sensitive question'), SyntaxError);
  await f.checkout('sych-chat-v1-' + 'a'.repeat(32));
  assert.deepEqual(f.handled, []);
  assert.deepEqual(f.forwarded, []);
  assert.equal(f.output.at(-1).checkout[1], false);
});

test('refund clears only the refunded package and duplicates are harmless', async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) await f.send('trial question');
  const first = await f.invoice();
  await f.checkout(first);
  await f.receipt(f.payment(first));
  await f.send('paid question');
  const second = await f.invoice();
  await f.checkout(second, 42, 'second-query');
  await f.receipt(f.payment(second, 'second-charge'));
  await f.receipt(f.payment(first), 'refunded_payment');
  await f.receipt(f.payment(first), 'refunded_payment');
  assert.equal(f.ledger().charges['charge:test-charge'].remaining, 0);
  assert.equal(f.ledger().charges['charge:second-charge'].remaining, 100);
  await f.send('another question');
  assert.equal(f.ledger().charges['charge:second-charge'].remaining, 99);
  assert.equal(f.forwarded.length, 10);
});


test('pausing sales rejects new payments but keeps purchased accounts private', async t => {
  const f = fixture(t);
  const payload = await f.invoice();
  await f.checkout(payload, 42, 'paused-query', 50, false);
  assert.equal(f.output.at(-1).checkout[1], false);
  await f.checkout(payload);
  await f.receipt(f.payment(payload), 'successful_payment', 42, false);
  assert.equal(f.hasPurchased(42), true);
  assert.equal(f.hasPurchased(43), false);
  f.restart();
  assert.equal(f.hasPurchased(42), true);
});

test('checkout preserves capacity for previously accepted invoices and paid replies', async t => {
  let capacity = 150;
  const f = fixture(t, { canPurchase: replies => replies <= capacity });
  const first = await f.invoice(42);
  const second = await f.invoice(43);
  await f.checkout(first, 42, 'first');
  assert.equal(f.output.at(-1).checkout[1], true);
  await f.checkout(second, 43, 'second');
  assert.equal(f.output.at(-1).checkout[1], false);

  await f.receipt(f.payment(first), 'successful_payment', 42);
  await f.checkout(second, 43, 'second');
  assert.equal(f.output.at(-1).checkout[1], false);
  capacity = 200;
  await f.checkout(second, 43, 'second');
  assert.equal(f.output.at(-1).checkout[1], true);

  capacity = 0;
  await f.send('/buy', 44);
  assert.match(f.output.at(-1).message[1], /покупки пока на паузе/i);
});

test('trial welcome and ordinary messages do not send a separate forwarding notice', async t => {
  const f = fixture(t);
  await f.send('/start');
  assert.doesNotMatch(f.output.at(-1).message[1], /копии обращений/i);
  const before = f.output.length;
  await f.send('question');
  assert.equal(f.output.length, before);
  assert.equal(f.forwarded.length, 1);
  await f.send('/terms');
  assert.doesNotMatch(f.output.at(-1).message[1], /копии обращений/i);
});

test('buy button only opens one invoice for the intended user', async t => {
  const f = fixture(t);
  await f.send('/buy');
  const offer = f.output.at(-1).message;
  assert.doesNotMatch(offer[1], /пересыл|копии обращений|buy confirm/i);
  const data = offer[2].reply_markup.inline_keyboard[0][0].callback_data;
  await f.tap(data, 43, 42);
  assert.equal(f.output.filter(o => o.invoice).length, 0);
  await Promise.all([f.tap(data), f.tap(data)]);
  assert.equal(f.output.filter(o => o.invoice).length, 1);
});
