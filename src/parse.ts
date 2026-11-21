import type { z } from 'zod';

import type { ERRORS_BY_KEY } from './errors';

import { PortoError } from './error';

function parseSchema<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  code: keyof typeof ERRORS_BY_KEY,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const location = issue.path.join('.');
        return location ? `${location}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new PortoError(code, details, { cause: result.error });
  }
  return result.data;
}

export { parseSchema };
