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
const icon = iconByLevel[level];
const query = new URLSearchParams({ chat_id: TELEGRAM_CHAT_ID ?? '', text: `${icon} ${message}` });
const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?${query.toString()}`;

const response = await fetch(url, { method: 'POST' });

if (!response.ok) throw new Error(await response.text());
