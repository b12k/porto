/* oxlint-disable perfectionist/sort-modules, unicorn/numeric-separators-style, unicorn/number-literal-case -- Helpers ordered for use; code points clearer as-is. */
const WIDE_RANGES: Array<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0xa4cf],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x2_0000, 0x3_fffd],
  [0x1_f300, 0x1_faff],
  [0x2600, 0x27bf],
];

function isWideCodePoint(code: number) {
  return WIDE_RANGES.some(([start, end]) => code >= start && code <= end);
}

function stripAnsi(text: string) {
  // oxlint-disable-next-line no-control-regex -- ANSI escapes must be stripped for width measurement.
  return text.replaceAll(/\[[0-9;]*m/gu, '');
}

function isZeroWidthCodePoint(code: number) {
  return code === 0x200b || code === 0xfe0f || code === 0x200d || (code >= 0x0300 && code <= 0x036f);
}

function displayWidth(text: string) {
  const clean = stripAnsi(text);
  let width = 0;
  for (const char of clean) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      width += 0;
    } else if (isZeroWidthCodePoint(code)) {
      width += 0;
    } else if (code < 0x1100) {
      width += 1;
    } else if (isWideCodePoint(code)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function maxLineDisplayWidth(text: string) {
  let max = 0;
  for (const line of text.split('\n')) {
    const width = displayWidth(line);
    if (width > max) {
      max = width;
    }
  }
  return max;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function wrapTextByWidth(text: string, maxWidth: number) {
  if (maxWidth <= 0) {
    return text;
  }
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  const lines: Array<string> = [];
  let current = '';
  let currentWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = displayWidth(segment);
    if (current !== '' && currentWidth + segmentWidth > maxWidth) {
      lines.push(current);
      current = '';
      currentWidth = 0;
    }
    current += segment;
    currentWidth += segmentWidth;
  }
  if (current !== '') {
    lines.push(current);
  }
  return lines.join('\n');
}

function formatLabeledField(label: string, value: string, termWidth: number) {
  const prefix = `  ${label}: `;
  const continuationIndent = '    ';
  const maxWidth = termWidth - displayWidth(prefix);
  const [first, ...rest] = value.split('\n').flatMap((line) => wrapTextByWidth(line, maxWidth).split('\n'));
  return [`${prefix}${first ?? ''}`, ...rest.map((line) => `${continuationIndent}${line}`)].join('\n');
}
export { formatLabeledField, maxLineDisplayWidth, wrapTextByWidth };
