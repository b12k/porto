import type { Options } from 'boxen';

import boxen from 'boxen';

import { libraryName } from './config';
import { PortoError } from './error';
import { ERRORS_BY_KEY } from './errors';

export function log(message: string, options: Options) {
  process.stderr.write(`${boxen(message, options)}\n`);
}

export function logError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const instruction = error instanceof PortoError ? ERRORS_BY_KEY[error.code].instruction : '';
  log([message, instruction].filter(Boolean).join('\n\n'), { borderColor: 'red', title: `[${libraryName}]` });
}
