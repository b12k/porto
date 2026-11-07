import { types } from 'node:util';
import { z } from 'zod';

import type { PortBlock } from './index';

import { PortoError } from './error';

export type VarFactory = (block: number, port: number, idx: number) => string;
export type Vars = (Record<string, VarFactory> | string)[];

type VarEntry = [string, undefined | VarFactory];

const VAR_NAME_SCHEMA = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const VAR_TEXT_SCHEMA = z.string().regex(/^[^\r\n\0]*$/u);
const VAR_RECORD_SCHEMA = z.custom<Record<string, VarFactory>>((record) => {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
  return Object.entries(record).every(
    ([name, factory]) => VAR_NAME_SCHEMA.safeParse(name).success && typeof factory === 'function',
  );
});
const VAR_ENTRY_SCHEMA = z.union([VAR_NAME_SCHEMA, VAR_RECORD_SCHEMA]);

function getVarEntries(vars: Vars) {
  return vars.flatMap<VarEntry>((entry) => (typeof entry === 'string' ? [[entry, undefined]] : Object.entries(entry)));
}

export const VARS_SCHEMA = z.array(VAR_ENTRY_SCHEMA).refine(
  (vars) => {
    const names = getVarEntries(vars).map(([name]) => name);
    return new Set(names).size === names.length;
  },
  { message: 'Variable names must be unique.' },
);

function parseVarsInput(vars: unknown) {
  const result = VARS_SCHEMA.safeParse(vars);
  if (!result.success) {
    throw new PortoError('mappingInvalid', result.error.issues.map((issue) => issue.message).join('; '), {
      cause: result.error,
    });
  }
  return result.data;
}

export function validateVars(vars: Vars, size: number) {
  const parsedVars = parseVarsInput(vars);
  if (getVarEntries(parsedVars).length > size) {
    throw new PortoError('mappingInvalid', 'Vars contain more entries than the block contains.');
  }
  return parsedVars;
}

export function mapBlockToVars(block: PortBlock, vars: Vars) {
  const entries = getVarEntries(validateVars(vars, block.end - block.start + 1));
  const mappedEntries = entries.map<[string, number | string]>(([name, factory], idx) => {
    const port = block.getPort(idx);
    if (factory === undefined) return [name, port];
    try {
      const text: unknown = factory(block.index, port, idx);
      if (types.isPromise(text)) {
        // oxlint-disable-next-line promise/prefer-await-to-then
        text.catch(() => {
          // Async factories are rejected below; observe their errors without awaiting them.
        });
      }
      return [name, VAR_TEXT_SCHEMA.parse(text)];
    } catch (error) {
      throw new PortoError('mappingInvalid', `Cannot create ${name}; expected a single-line string.`, { cause: error });
    }
  });
  return Object.fromEntries(mappedEntries);
}

function parseVar(entry: string) {
  const separator = entry.indexOf(':');
  const name = (separator === -1 ? entry : entry.slice(0, separator)).trim();
  if (separator === -1) return name;
  const template = entry.slice(separator + 1);
  const result = VAR_TEXT_SCHEMA.safeParse(template);
  if (!result.success) {
    throw new PortoError('mappingInvalid', 'Vars templates must fit on one line.', { cause: result.error });
  }
  return {
    [name](block: number, port: number) {
      return template.replaceAll('{{block}}', String(block)).replaceAll('{{port}}', String(port));
    },
  };
}

export function parseVars(source: string) {
  return parseVarsInput(source.split(';').map((entry) => parseVar(entry)));
}
