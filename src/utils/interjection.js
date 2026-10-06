'use strict';

// Спонтанное вмешательство в чат: бот сам решает влезть в разговор, без обращения по имени.
// Здесь только чистые функции — их проверяет test/interjection.test.js без сети и Telegram.

// Слишком короткие реплики («ок», «ахах», «+») — не повод вмешиваться.
const MIN_MESSAGE_CHARS = 10;

function normalizeChance(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

// Решение о вмешательстве: шанс + кулдаун на чат.
// random и now передаются параметрами, чтобы поведение проверялось тестом.
function shouldInterject({ chance, cooldownMs, lastAt = 0, now = Date.now(), random = Math.random } = {}) {
  const ratio = normalizeChance(chance, 0);
  if (ratio <= 0) return false;

  const cooldown = Number(cooldownMs);
  if (Number.isFinite(cooldown) && cooldown > 0 && lastAt > 0 && now - lastAt < cooldown) {
    return false;
  }

  return random() < ratio;
}

// Реплика вмешательства должна быть короткой: схлопываем пробелы и режем по границе предложения.
function trimInterjection(text, maxChars = 300) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 300;
  if (clean.length <= limit) return clean;

  const cut = clean.slice(0, limit);
  const lastStop = Math.max(
    cut.lastIndexOf('.'),
    cut.lastIndexOf('!'),
    cut.lastIndexOf('?'),
    cut.lastIndexOf('…')
  );
  if (lastStop > limit * 0.5) return cut.slice(0, lastStop + 1).trim();

  return `${cut.trim()}…`;
}

module.exports = { MIN_MESSAGE_CHARS, normalizeChance, shouldInterject, trimInterjection };
