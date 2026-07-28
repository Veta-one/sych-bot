class OperationTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} превысил таймаут ${timeoutMs} мс`);
    this.name = 'OperationTimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

async function withTimeout(operation, timeoutMs, label = 'Операция') {
  const safeTimeoutMs = Math.max(1, Number(timeoutMs) || 1);
  let timer;

  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new OperationTimeoutError(label, safeTimeoutMs));
        }, safeTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  OperationTimeoutError,
  withTimeout,
};
