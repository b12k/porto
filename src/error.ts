import { ERRORS_BY_KEY } from './errors';

export class PortoError extends Error {
  public readonly code: keyof typeof ERRORS_BY_KEY;

  public constructor(code: keyof typeof ERRORS_BY_KEY, details?: string, options?: ErrorOptions) {
    super([ERRORS_BY_KEY[code].message, details].filter(Boolean).join(' '), options);
    this.code = code;
    this.name = 'PortoError';
  }
}
