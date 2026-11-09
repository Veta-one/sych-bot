const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const { BlockList, isIP } = require('node:net');
const { randomBytes } = require('node:crypto');
const MarkdownIt = require('markdown-it');
const { parseDocument } = require('htmlparser2');
const { stripImageMarkup } = require('./quotes');

const markdown = new MarkdownIt({ html: true, linkify: false });
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15000;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function photoUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (typeof value !== 'string' || value.length > 2048 || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.port || !host.includes('.') || isIP(host)
      || /(?:^|\.)(?:local|localhost|internal|test|invalid)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

function photoUrls(rich) {
  const html = rich.html ?? markdown.render(rich.markdown || '');
  const urls = new Set();
  function visit(node) {
    if (['pre', 'code', 'script', 'style'].includes(node.name)) return;
    if (node.name === 'img') {
      const url = photoUrl(node.attribs?.src);
      if (url && urls.size < MAX_PHOTOS) urls.add(url);
    }
    for (const child of node.children || []) visit(child);
  }
  visit(parseDocument(html));
  return [...urls];
}

// Reject non-image bodies, incomplete PNG chunks and invalid photo dimensions.
function photoFormat(data) {
  let width, height, type;
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.toString('ascii', 12, 16) === 'IHDR' && data.toString('ascii', data.length - 8, data.length - 4) === 'IEND') {
    let imageBytes = 0, ended = false;
    for (let offset = 8; offset + 12 <= data.length;) {
      const size = data.readUInt32BE(offset);
      const end = offset + size + 12;
      if (end > data.length) return null;
      const chunk = data.toString('ascii', offset + 4, offset + 8);
      if (offset === 8 && size !== 13) return null;
      if (chunk === 'IDAT') imageBytes += size;
      if (chunk === 'IEND') { ended = size === 0 && end === data.length; break; }
      offset = end;
    }
    if (!imageBytes || !ended) return null;
    width = data.readUInt32BE(16); height = data.readUInt32BE(20); type = 'png';
  } else if (data.length > 20 && data[0] === 255 && data[1] === 216 && data[data.length - 2] === 255 && data[data.length - 1] === 217) {
    let scanned = false;
    for (let offset = 2; offset + 8 < data.length;) {
      if (data[offset++] !== 255) return null;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 217 || offset + 2 > data.length) return null;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) return null;
      if (marker === 218) {
        if (size < 6 || offset + size >= data.length - 2) return null;
        scanned = true; break;
      }
      if ([192, 193, 194].includes(marker)) {
        if (size < 8) return null;
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); type = 'jpg';
      }
      offset += size;
    }
    if (!scanned) return null;
  }
  return width > 0 && height > 0 && width + height <= 10000 && Math.max(width, height) / Math.min(width, height) <= 20
    ? type : null;
}

async function downloadPhoto(value, { signal, budget, lookup = dns.lookup, request } = {}) {
  let location = value;
  const resources = budget || { bytes: 0 };
  for (let hop = 0; hop < 4; hop++) {
    const validated = photoUrl(location);
    if (!validated || signal?.aborted) return null;
    const url = new URL(validated);
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(row => !publicAddress(row.address)) || signal?.aborted) return null;
    const selected = addresses.find(row => row.family === 4) || addresses[0];
    const options = { signal, agent: false, family: selected.family, headers: {
      Accept: 'image/jpeg,image/png', 'User-Agent': 'SychBot/1.0',
    }, lookup: (_, opts, callback) => opts.all ? callback(null, [selected]) : callback(null, selected.address, selected.family) };
    const response = await new Promise((resolve, reject) => {
      const req = (request || (url.protocol === 'https:' ? https.get : http.get))(url, options, resolve);
      req.once('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (typeof response.headers.location !== 'string') return null;
      location = new URL(response.headers.location, url).href;
      continue;
    }
    if (response.statusCode !== 200 || !/^image\/(?:jpeg|png)(?:;|$)/i.test(response.headers['content-type'] || '')
      || Number(response.headers['content-length']) > MAX_PHOTO_BYTES) { response.destroy(); return null; }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length; resources.bytes += chunk.length;
      if (signal?.aborted || size > MAX_PHOTO_BYTES || resources.bytes > MAX_TOTAL_BYTES) { response.destroy(); return null; }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks, size);
    const extension = photoFormat(data);
    return extension ? { data, extension, url: value } : null;
  }
  return null;
}

function withPhotos(rich, photos, uploaded) {
  const field = rich.markdown != null ? 'markdown' : 'html';
  const text = stripImageMarkup(rich[field]);
  const tags = photos.map((_, index) => `<img src="tg://photo?id=p${index}"/>`).join('');
  const gallery = photos.length > 1 ? `<tg-slideshow>${tags}</tg-slideshow>` : tags;
  const marker = '<details><summary>Ссылки на фото</summary>';
  const at = text.indexOf(marker);
  const body = at < 0 ? `${text}\n\n${gallery}` : `${text.slice(0, at)}${gallery}\n\n${text.slice(at)}`;
  return { [field]: body, media: photos.map((photo, index) => ({
    id: `p${index}`, media: { type: 'photo', media: uploaded ? `attach://photo${index}` : photo.url },
  })) };
}

function explicitPhotos(rich) {
  const urls = photoUrls(rich);
  return urls.length ? withPhotos(rich, urls.map(url => ({ url })), false) : null;
}

async function uploadedPhotos(rich, { download = downloadPhoto } = {}) {
  const urls = photoUrls(rich);
  if (!urls.length) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const budget = { bytes: 0 };
  const completed = new Array(urls.length);
  let onAbort;
  const expired = new Promise(resolve => {
    onAbort = () => resolve([]);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // Two concurrent downloads bound sockets and in-flight buffers.
    for (let offset = 0; offset < urls.length && !controller.signal.aborted; offset += 2) {
      await Promise.race([expired, Promise.all(urls.slice(offset, offset + 2).map(async (url, index) => {
        const photo = await download(url, { signal: controller.signal, budget }).catch(() => null);
        if (!controller.signal.aborted) completed[offset + index] = photo;
      }))]);
    }
    const photos = completed.filter(Boolean);
    return photos.length ? { rich: withPhotos(rich, photos, true), photos } : null;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

function multipartPhotos(payload, prepared) {
  const boundary = 'sych-' + randomBytes(18).toString('hex');
  const parts = [];
  for (const [key, value] of Object.entries({ ...payload, rich_message: prepared.rich })) {
    const content = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${content}\r\n`));
  }
  prepared.photos.forEach(({ data, extension }, index) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo${index}"; filename="photo${index}.${extension}"\r\nContent-Type: image/${extension === 'jpg' ? 'jpeg' : 'png'}\r\n\r\n`),
      data, Buffer.from('\r\n'));
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

module.exports = { photoUrls, explicitPhotos, uploadedPhotos, multipartPhotos, downloadPhoto, publicAddress, photoFormat };
