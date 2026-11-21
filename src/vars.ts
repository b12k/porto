import { isPlainObject } from 'es-toolkit';
import { types } from 'node:util';
import { z } from 'zod';

import type { PortSlot } from './index';

import { PortoError } from './error';

type VarEntry = string | VarFactory;
type VarEntryResult<Entry extends VarEntry> = Entry extends string
  ? string extends Entry
    ? Partial<Record<string, number>>
    : Record<Entry, number>
  : Entry extends VarFactory
    ? ReturnType<Entry>
    : never;
type VarFactory = (port: number, slot: number) => Record<string, number | string>;
type Vars = ReadonlyArray<VarEntry>;
type VarsResult<Entries extends Vars> = Entries extends readonly [
  infer Entry extends VarEntry,
  ...infer Rest extends Vars,
]
  ? VarEntryResult<Entry> & VarsResult<Rest>
  : number extends Entries['length']
    ? Partial<Record<string, number | string>>
    : object;

const VAR_NAME_SCHEMA = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const VAR_TEXT_SCHEMA = z.string().regex(/^[^\r\n\0]*$/u);
const VAR_FACTORY_SCHEMA = z.custom<VarFactory>((entry) => typeof entry === 'function');
const VAR_RESULT_ENTRY_SCHEMA = z.tuple([VAR_NAME_SCHEMA, z.union([VAR_TEXT_SCHEMA, z.number()])]);
const VAR_RESULT_SCHEMA = z
  .custom<Record<string, unknown>>(isPlainObject)
  .transform((variables) => Object.entries(variables))
  .pipe(z.array(VAR_RESULT_ENTRY_SCHEMA));

const VAR_VALUES_SCHEMA = VAR_RESULT_SCHEMA.transform((entries) => Object.fromEntries(entries));

const VARS_SCHEMA = z.array(z.union([VAR_NAME_SCHEMA, VAR_FACTORY_SCHEMA])).refine(
  (entries) => {
    const names = entries.filter((entry) => typeof entry === 'string');
    return new Set(names).size === names.length;
  },
  { message: 'Variable names must be unique.' },
);

function assertVarsFit(varsCount: number, size: number) {
  if (varsCount > size) {
    throw new PortoError('mappingInvalid', 'Vars contain more entries than the slot contains.');
  }
}

function mapVarEntry(entry: VarEntry, slot: Pick<PortSlot, 'firstPort' | 'index'>, index: number) {
  const port = slot.firstPort + index;
  if (typeof entry === 'string') return [[entry, port] as const];
  try {
    const variables: unknown = entry(port, slot.index);
    if (types.isPromise(variables)) {
      // Attach a no-op handler to avoid unhandled rejection noise; async factories are unsupported.
      variables.catch(() => {
        // Async factories are rejected below with mappingInvalid.
      });
      throw new PortoError(
        'mappingInvalid',
        `Cannot create variables for entry ${index + 1}; async factories are not supported, return a plain object.`,
      );
    }
    return VAR_RESULT_SCHEMA.parse(variables);
  } catch (error) {
    throw new PortoError(
      'mappingInvalid',
      `Cannot create variables for entry ${index + 1}; expected an object with valid names and single-line strings or finite numbers.`,
      { cause: error },
    );
  }
}

function mapSlotToVars(slot: Pick<PortSlot, 'firstPort' | 'index'>, entries: Vars) {
  const environment = new Map<string, number | string>();
  for (const [index, entry] of entries.entries()) {
    for (const [name, value] of mapVarEntry(entry, slot, index)) {
      if (environment.has(name)) {
        throw new PortoError('mappingInvalid', `Variable names must be unique. Duplicate: ${name}.`);
      }
      environment.set(name, value);
    }
  }
  return Object.fromEntries(environment);
}

function parseVar(source: string) {
  const separator = source.indexOf('=');
  const name = (separator === -1 ? source : source.slice(0, separator)).trim();
  if (separator === -1) return { name };
  const template = source.slice(separator + 1);
  const result = VAR_TEXT_SCHEMA.safeParse(template);
  if (!result.success) {
    throw new PortoError('mappingInvalid', 'Vars templates must fit on one line.', { cause: result.error });
  }
  return { name, template };
}

function parseVarEntries(vars: unknown) {
  const result = VARS_SCHEMA.safeParse(vars);
  if (!result.success) {
    throw new PortoError('mappingInvalid', result.error.issues.map((issue) => issue.message).join('; '), {
      cause: result.error,
    });
  }
  return result.data;
}

function parseVars(source: string) {
  const groups = source.split(';').map((group) => group.split('|').map((entry) => parseVar(entry)));
  parseVarEntries(groups.flat().map(({ name }) => name));
  return groups.map<VarEntry>((group) => {
    const [firstVar] = group;
    if (group.length === 1 && firstVar && firstVar.template === undefined) return firstVar.name;
    return (port, slot) =>
      Object.fromEntries(
        group.map(({ name, template }) => [
          name,
          template?.replaceAll('{{slot}}', String(slot)).replaceAll('{{port}}', String(port)) ?? port,
        ]),
      );
  });
}

export { assertVarsFit, mapSlotToVars, parseVarEntries, parseVars, VAR_VALUES_SCHEMA, VARS_SCHEMA };
export type { VarEntry, VarFactory, Vars, VarsResult };
