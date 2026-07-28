function shouldSkipSearchForPrimarySource(message, hasPrimarySource) {
  if (!hasPrimarySource) return false;

  const text = String(message || '').toLowerCase();
  const explicitlyNeedsExternalData = [
    /(?:поищи|найди|проверь|сверь|дополни).{0,50}(?:в интернете|в сети|поиск|актуальн|сегодня|сейчас|новост|рынк)/,
    /(?:сравни|сопоставь).{0,50}(?:рынок|актуальн|интернет|сеть|сегодня|сейчас|новост)/,
    /(?:internet|web search|latest|current news|market data)/,
  ].some(pattern => pattern.test(text));

  return !explicitlyNeedsExternalData;
}

module.exports = {
  shouldSkipSearchForPrimarySource,
};
