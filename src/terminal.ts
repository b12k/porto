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
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (current !== '' && currentWidth + charWidth > maxWidth) {
      lines.push(current);
      current = '';
      currentWidth = 0;
    }
    current += char;
    currentWidth += charWidth;
  }
  if (current !== '') {
    lines.push(current);
  }
  return lines.join('\n');
}

function pushWrappedPart(lines: Array<string>, part: string, maxWidth: number) {
  if (displayWidth(part) <= maxWidth) {
    lines.push(part);
  } else {
    for (const hardLine of wrapTextByWidth(part, maxWidth).split('\n')) {
      lines.push(hardLine);
    }
  }
}

function wrapCommaValue(value: string, maxWidth: number) {
  if (displayWidth(value) <= maxWidth) {
    return value;
  }
  const lines: Array<string> = [];
  let current = '';
  for (const part of value.split(', ')) {
    const candidate = current === '' ? part : `${current}, ${part}`;
    if (current !== '' && displayWidth(candidate) > maxWidth) {
      // Keep the separator at the end of the broken line.
      pushWrappedPart(lines, `${current},`, maxWidth);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current !== '') {
    pushWrappedPart(lines, current, maxWidth);
  }
  return lines.join('\n');
}

function formatLabeledField(label: string, value: string, termWidth: number) {
  const prefix = `  ${label}: `;
  const continuationIndent = '    ';
  const maxFirst = termWidth - displayWidth(prefix);
  const maxCont = termWidth - displayWidth(continuationIndent);
  if (maxFirst <= 0 || maxCont <= 0) {
    return `${prefix}${value}`;
  }
  const limit = Math.min(maxFirst, maxCont);
  const wrapped = wrapCommaValue(value, limit);
  const parts = wrapped.split('\n');
  const first = parts[0] ?? '';
  const rest = parts.slice(1).map((line) => `${continuationIndent}${line}`);
  return [`${prefix}${first}`, ...rest].join('\n');
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function truncateMiddle(text: string, maxLength: number) {
  if (displayWidth(text) <= maxLength) return text;
  const ellipsis = '…';
  const keep = maxLength - displayWidth(ellipsis);
  const front = Math.ceil(keep / 2);
  const back = Math.floor(keep / 2);
  const segments = [...graphemeSegmenter.segment(text)].map((segment) => segment.segment);
  const head: Array<string> = [];
  let headWidth = 0;
  for (const segment of segments) {
    const width = displayWidth(segment);
    if (headWidth + width > front) break;
    head.push(segment);
    headWidth += width;
  }
  const tail: Array<string> = [];
  let tailWidth = 0;
  for (let position = segments.length - 1; position >= 0; position -= 1) {
    const segment = segments[position];
    if (segment === undefined) break;
    const width = displayWidth(segment);
    if (tailWidth + width > back) break;
    tail.unshift(segment);
    tailWidth += width;
  }
  return `${head.join('')}${ellipsis}${tail.join('')}`;
}

export { displayWidth, formatLabeledField, maxLineDisplayWidth, truncateMiddle, wrapCommaValue, wrapTextByWidth };
