const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');
const photos = require('../src/utils/rich-photos');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKqkAAAAASUVORK5CYII=', 'base64');
const urls = ['https://images.example.org/a.png', 'https://images.example.org/unavailable.png', 'https://images.example.org/b.png'];
const rich = { markdown: 'Описание.\n\n<tg-slideshow>' + urls.map(url => `<img src="${url}"/>`).join('')
  + '</tg-slideshow>\n\n<details><summary>Ссылки на фото</summary>Ссылки</details>' };
const preparedPhotos = [0, 2].map(index => ({ url: urls[index], data: png, extension: 'png' }));
const fixturePrepared = () => photos.uploadedPhotos(rich, { download: async url => preparedPhotos.find(photo => photo.url === url) || null });
const rejected = () => Object.assign(new Error('Photo rejected'), { response: {
  status: 400, data: { ok: false, error_code: 400, description: 'Bad Request: RICH_MESSAGE_PHOTO_NO_MEDIA_FOUND' },
} });

test('only actual public photo blocks are recovered, not code examples or internal URLs', () => {
  const input = { markdown: rich.markdown + '\n\n```html\n<img src="https://images.example.org/code.png"/>\n```'
    + '\n<img src="http://127.0.0.1/private.png"/><img src="http://host.local/private.png"/>' };
  assert.deepEqual(photos.photoUrls(input), urls);
  const explicit = photos.explicitPhotos(input);
  assert.equal(explicit.media.length, 3);
  assert.equal(explicit.media[0].media.media, urls[0]);
  assert.match(explicit.markdown, /tg:\/\/photo\?id=p0/);
  assert.match(explicit.markdown, /<img src="https:\/\/images\.example\.org\/code\.png"/);
});

test('downloaded photos preserve source order, skip failures and use correct multipart references', async () => {
  const prepared = await fixturePrepared();
  assert.deepEqual(prepared.photos.map(photo => photo.url), [urls[0], urls[2]]);
  assert.match(prepared.rich.markdown, /<tg-slideshow><img src="tg:\/\/photo\?id=p0"\/><img src="tg:\/\/photo\?id=p1"\/><\/tg-slideshow>/);
  const payload = { chat_id: -123, message_thread_id: 7, reply_parameters: { message_id: 19, allow_sending_without_reply: false } };
  const form = photos.multipartPhotos(payload, prepared);
  const fields = await new Response(form.body, { headers: { 'Content-Type': form.contentType } }).formData();
  assert.equal(fields.get('chat_id'), '-123');
  assert.equal(fields.get('message_thread_id'), '7');
  assert.deepEqual(JSON.parse(fields.get('reply_parameters')), payload.reply_parameters);
  const message = JSON.parse(fields.get('rich_message'));
  assert.deepEqual(message.media.map(item => item.media.media), ['attach://photo0', 'attach://photo1']);
  assert.equal(fields.get('photo0').type, 'image/png');
  assert.deepEqual(Buffer.from(await fields.get('photo0').arrayBuffer()), png);
});

test('one remaining photo loses the slideshow wrapper; no photos allow text fallback', async () => {
  const one = await photos.uploadedPhotos(rich, { download: async url => url === urls[2] ? preparedPhotos[1] : null });
  assert.doesNotMatch(one.rich.markdown, /tg-slideshow/);
  assert.match(one.rich.markdown, /<img src="tg:\/\/photo\?id=p0"/);
  assert.equal(await photos.uploadedPhotos(rich, { download: async () => null }), null);
});

test('photo downloads reject private, mapped, multicast and transition addresses', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) {
    assert.equal(photos.publicAddress(address), false, address);
    assert.equal(await photos.downloadPhoto(urls[0], {
      lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      request: () => assert.fail('Private resolution opened a socket'),
    }), null);
  }
  assert.equal(photos.publicAddress('8.8.8.8'), true);
  assert.equal(photos.publicAddress('2606:4700:4700::1111'), true);
});

function network(responseFor, resolve = async () => [{ address: '8.8.8.8', family: 4 }]) {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push(url.href);
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
    });
    const row = responseFor(url);
    const response = Readable.from(row.body || [png]);
    response.statusCode = row.statusCode || 200;
    response.headers = { 'content-type': 'image/png', ...row.headers };
    queueMicrotask(() => callback(response));
    return new EventEmitter();
  };
  return { request, lookup: resolve, calls };
}

test('photo downloads pin the checked address and revalidate every redirect destination', async () => {
  const good = network(() => ({}));
  const result = await photos.downloadPhoto(urls[0], good);
  assert.deepEqual(result.data, png);
  assert.equal(result.extension, 'png');
  const bad = network(() => ({ statusCode: 302, headers: { location: 'https://private.example.org/private.png' } }),
    async host => [{ address: host === 'images.example.org' ? '8.8.8.8' : '10.0.0.1', family: 4 }]);
  assert.equal(await photos.downloadPhoto(urls[0], bad), null);
  assert.equal(bad.calls.length, 1);
  const mixed = network(() => ({}), async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  assert.equal(await photos.downloadPhoto(urls[0], mixed), null);
  assert.equal(mixed.calls.length, 0);
});

test('HTML bodies, oversized streams and invalid image headers are rejected', async () => {
  for (const row of [
    { headers: { 'content-type': 'text/html' }, body: [Buffer.from('<html>captcha</html>')] },
    { headers: { 'content-length': String(6 * 1024 * 1024) } },
    { body: [Buffer.alloc(5 * 1024 * 1024 + 1)] },
    { body: [Buffer.from('not an image')] },
  ]) assert.equal(await photos.downloadPhoto(urls[0], network(() => row)), null);
  assert.equal(photos.photoFormat(png), 'png');
  assert.equal(photos.photoFormat(Buffer.from('ffd8ffc00011080050006003012200021101031101ffd9', 'hex')), null);
});

test('a shared deadline finishes even when DNS or a download does not settle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const work = photos.uploadedPhotos(rich, { download: async () => new Promise(() => {}) });
  t.mock.timers.tick(15000);
  assert.equal(await work, null);
});

test('a finished image survives when another image in the same batch times out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const work = photos.uploadedPhotos(rich, { download: async url => url === urls[0]
    ? preparedPhotos[0] : new Promise(() => {}) });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(15000);
  assert.deepEqual((await work).photos.map(photo => photo.url), [urls[0]]);
});

function transport(respond, overrides = {}) {
  const box = { exports: {} }, calls = [], legacy = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/rich.js'), 'utf8'), {
    module: box, console: { error() {}, log() {} },
    require: name => name === 'axios' ? { post: async (url, body, options) => {
      calls.push({ url, body, options }); return respond(calls.at(-1), calls.length);
    } } : name === '../config' ? { telegramToken: 'synthetic' }
      : name === './rich-photos' ? { ...photos, uploadedPhotos: fixturePrepared, ...overrides }
        : name === './quotes' ? require('../src/utils/quotes') : {},
  });
  const bot = { sendMessage: async (...args) => { legacy.push(args); return { message_id: 100 }; } };
  return { calls, legacy, bot, send: options => box.exports.sendRich(bot, -123, rich, options || { replyTo: 19, threadId: 7 }) };
}

test('confirmed photo rejection recovers via explicit media and preserves reply scope', async () => {
  const h = transport((call, index) => {
    if (index === 1) throw rejected();
    assert.equal(call.body.rich_message.media[0].media.type, 'photo');
    assert.equal(call.body.reply_parameters.message_id, 19);
    assert.equal(call.body.message_thread_id, 7);
    return { status: 200, data: { ok: true, result: { message_id: 100 } } };
  });
  assert.equal((await h.send()).mode, 'rich');
  assert.equal(h.calls.length, 2);
  assert.equal(h.legacy.length, 0);
});

test('a private photo retry retains the original recipient and ephemeral reply', async () => {
  const h = transport((call, index) => {
    if (index === 1) throw rejected();
    assert.equal(call.body.ephemeral_message_parameters.receiver_user_id, 1234);
    assert.equal(call.body.reply_parameters.ephemeral_message_id, 77);
    assert.equal(call.body.rich_message.media.length, 3);
    return { status: 200, data: { ok: true, result: { ephemeral_message_id: 88, receiver_user: { id: 1234 } } } };
  });
  const result = await h.send({ ephemeral: { receiverUserId: 1234, replyToEphemeralId: 77 } });
  assert.equal(result.ephemeralMessageId, 88);
  assert.equal(h.legacy.length, 0);
});

test('an initial gallery connection reset cannot cause a second public message', async () => {
  for (const code of ['ECONNRESET', 'ERR_BAD_RESPONSE']) {
    const h = transport(() => { throw Object.assign(new Error('reset after write'), { code, isAxiosError: true }); });
    await assert.rejects(h.send(), error => error.code === 'RICH_DELIVERY_UNCONFIRMED');
    assert.equal(h.calls.length, 1);
    assert.equal(h.legacy.length, 0);
  }
});

test('a failed explicit retry uploads only valid photos, with group access checked before the upload', async () => {
  let allowed = true, checks = 0;
  const h = transport(async (call, index) => {
    if (index < 3) throw rejected();
    assert.ok(Buffer.isBuffer(call.body));
    const fields = await new Response(call.body, { headers: { 'Content-Type': call.options.headers['Content-Type'] } }).formData();
    assert.equal(fields.get('chat_id'), '-123');
    assert.equal(fields.get('message_thread_id'), '7');
    assert.equal(JSON.parse(fields.get('rich_message')).media.length, 2);
    return { status: 200, data: { ok: true, result: { message_id: 100 } } };
  });
  h.bot.requireGroupAccess = async () => { checks++; assert.ok(allowed); };
  assert.equal((await h.send()).messageId, 100);
  assert.equal(h.calls.length, 3);
  assert.equal(checks, 4); // sendRich entry and each of its three HTTP requests.
  allowed = false;
});

test('group denial after downloads and ambiguous recovery responses stop all further sends', async () => {
  for (const mode of ['denied', 'timeout', 'server-error']) {
    let allowed = true;
    const h = transport((call, index) => {
      if (index < 3) throw rejected();
      if (mode === 'timeout') throw new Error('timeout');
      return { status: 503, data: { ok: false, error_code: 503 } };
    }, { uploadedPhotos: async () => {
      if (mode === 'denied') allowed = false;
      return fixturePrepared();
    } });
    h.bot.requireGroupAccess = async () => { if (!allowed) throw new Error('group denied'); };
    await assert.rejects(h.send(), error => error.code === 'RICH_DELIVERY_UNCONFIRMED');
    assert.equal(h.calls.length, mode === 'denied' ? 2 : 3);
    assert.equal(h.legacy.length, 0);
  }
});
