function isExplicitTelegramIdentity(value) {
  const target = String(value || '').trim();
  return /^@[A-Za-z0-9_]{5,32}$/.test(target)
    || /^\d{5,15}$/.test(target);
}

function shouldHandleProfileQuery(value, matchedProfile) {
  return Boolean(matchedProfile) || isExplicitTelegramIdentity(value);
}

module.exports = {
  isExplicitTelegramIdentity,
  shouldHandleProfileQuery,
};
