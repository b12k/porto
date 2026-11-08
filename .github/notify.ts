const iconByLevel = { error: '❌', info: 'ℹ️', success: '✅', warning: '⚠️' } as const;
const levels = Object.keys(iconByLevel);

type Level = keyof typeof iconByLevel;

function checkIsLevel(value: unknown): value is Level {
  return typeof value === 'string' && levels.includes(value);
}

const [level, ...messageParts] = process.argv.slice(2);
if (!checkIsLevel(level)) {
  throw new Error(`Invalid notification level. Expected: ${levels.join(', ')}.`);
}
const message = messageParts.join(' ');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  process.stdout.write('::warning::Telegram notification skipped because its secrets are missing.\n');
} else {
  const query = new URLSearchParams({ chat_id: TELEGRAM_CHAT_ID, text: `${iconByLevel[level]} ${message}` });
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?${query.toString()}`;
  try {
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) process.stdout.write(`::warning::Telegram notification failed with HTTP ${response.status}.\n`);
  } catch {
    process.stdout.write('::warning::Telegram notification request failed.\n');
  }
}
