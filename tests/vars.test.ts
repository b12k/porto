import { expect, it } from '@rstest/core';
import { setImmediate } from 'node:timers/promises';

import type { Vars } from '../src/vars';

import { PortoError } from '../src/error';
import { buildBlock } from '../src/ports';
import { assertVarsFit, mapBlockToVars, parseVarEntries, parseVars, VARS_SCHEMA } from '../src/vars';

function createSpecialVar(_block: number, port: number) {
  return { ['__proto__']: port };
}

it('shares one indexed port across variables from the same factory', () => {
  const portBlock = buildBlock({ index: 2, size: 3, start: 1000 });
  const vars: Vars = [
    'API_PORT',
    (block, port, idx) => ({ CLIENT_PORT: port, CLIENT_URL: `http://wt${block}.localhost:${port}/${idx}` }),
    'LAST_PORT',
  ];
  expect(mapBlockToVars(portBlock, parseVarEntries(vars))).toEqual({
    API_PORT: 1006,
    CLIENT_PORT: 1007,
    CLIENT_URL: 'http://wt2.localhost:1007/1',
    LAST_PORT: 1008,
  });
});

it('uses the same indexed semantics for CLI templates and structured vars', () => {
  const block = buildBlock({ index: 2, size: 4, start: 1000 });
  const vars = parseVars('API_PORT;CLIENT_HOST=wt{{block}}.localhost;URL=http://localhost:{{port}}/{{port}};LAST_PORT');
  expect(mapBlockToVars(block, vars)).toEqual({
    API_PORT: 1008,
    CLIENT_HOST: 'wt2.localhost',
    LAST_PORT: 1011,
    URL: 'http://localhost:1010/1010',
  });
});

it('validates without executing factories and preserves their identities', () => {
  let callsCount = 0;
  function createHost(block: number) {
    callsCount += 1;
    return { HOST: `wt${block}.localhost` };
  }
  const vars = parseVarEntries([createHost]);
  expect(callsCount).toBe(0);
  expect(vars[0]).toBe(createHost);
  expect(mapBlockToVars(buildBlock({ index: 2, size: 1, start: 1000 }), vars)).toEqual({ HOST: 'wt2.localhost' });
  expect(callsCount).toBe(1);
});

it('rejects invalid names, duplicates and multiline CLI templates', () => {
  expect(() => parseVars('BAD-NAME')).toThrow(PortoError);
  expect(() => parseVars('')).toThrow(PortoError);
  expect(() => parseVars('A;A')).toThrow(PortoError);
  expect(() => parseVars('A:{{port}}')).toThrow(PortoError);
  expect(() => parseVars('A={{port}};A')).toThrow(PortoError);
  expect(() => parseVars('A|A={{port}}')).toThrow(PortoError);
  expect(() => parseVars('A|B;B')).toThrow(PortoError);
  expect(() => parseVars('A||B')).toThrow(PortoError);
  expect(() => parseVars('A|B-INVALID={{port}}')).toThrow(PortoError);
  expect(() => parseVars('A;')).toThrow(PortoError);
  expect(() => parseVars('A=line\nnext')).toThrow(PortoError);
  expect(VARS_SCHEMA.safeParse([{ API_PORT: () => '1000' }]).success).toBe(false);
  expect(VARS_SCHEMA.safeParse(['API_PORT', 'API_PORT']).success).toBe(false);
});

it('checks the number of entries before calling factories', () => {
  let callsCount = 0;
  const vars: Vars = [
    () => {
      callsCount += 1;
      return { FIRST: 'a', SECOND: 'b' };
    },
    'LAST_PORT',
  ];
  const entries = parseVarEntries(vars);
  assertVarsFit(entries.length, 2);
  expect(() => {
    assertVarsFit(entries.length, 1);
  }).toThrow(PortoError);
  expect(callsCount).toBe(0);
});

it.each([
  ['a number', 42],
  ['undefined', undefined],
  ['an array', ['TITLE']],
  ['an invalid name', { 'BAD-NAME': 'bad key' }],
  ['a boolean value', { TITLE: true }],
  ['a line feed', { TITLE: 'line\nnext' }],
  ['a carriage return', { TITLE: 'line\rnext' }],
  ['a NUL byte', { TITLE: 'nul\0byte' }],
  ['NaN', { TITLE: Number.NaN }],
  ['infinity', { TITLE: Number.POSITIVE_INFINITY }],
])('rejects factory output with %s', (_label, returned) => {
  const vars = VARS_SCHEMA.parse([() => returned]);
  expect(() => mapBlockToVars(buildBlock({ index: 0, size: 1, start: 1000 }), vars)).toThrow(PortoError);
});

it('rejects duplicate output names from strings and factories', () => {
  const block = buildBlock({ index: 0, size: 2, start: 1000 });
  for (const vars of [
    ['__proto__', createSpecialVar],
    [createSpecialVar, '__proto__'],
    [createSpecialVar, createSpecialVar],
  ]) {
    const entries = parseVarEntries(vars);
    expect(() => mapBlockToVars(block, entries)).toThrow('Duplicate: __proto__.');
  }
});

it('wraps factory errors with the entry number and the original cause', () => {
  const factoryError = new Error('Factory failed.');
  let mappingError: unknown;
  try {
    const entries = parseVarEntries([
      () => {
        throw factoryError;
      },
    ]);
    mapBlockToVars(buildBlock({ index: 0, size: 1, start: 1000 }), entries);
  } catch (error) {
    mappingError = error;
  }
  expect(mappingError).toBeInstanceOf(PortoError);
  expect(mappingError).toHaveProperty('code', 'mappingInvalid');
  expect(mappingError).toHaveProperty('cause', factoryError);
  expect(mappingError).toHaveProperty('message', expect.stringContaining('Cannot create variables for entry 1'));
});

it('rejects async factories without leaving an unhandled rejection', async () => {
  let callsCount = 0;
  const vars = VARS_SCHEMA.parse([
    async () => {
      callsCount += 1;
      await setImmediate();
      throw new Error('Async factory failed.');
    },
  ]);
  expect(() => mapBlockToVars(buildBlock({ index: 0, size: 1, start: 1000 }), vars)).toThrow(PortoError);
  await setImmediate();
  expect(callsCount).toBe(1);
});

it('preserves special property names and JSON-compatible template strings', () => {
  const block = buildBlock({ index: 0, size: 3, start: 1000 });
  const vars = parseVars('__proto__={{port}};constructor;TITLE=Bob\'s "dev"');
  const environment = mapBlockToVars(block, vars);
  expect(Object.hasOwn(environment, '__proto__')).toBe(true);
  expect(environment).toEqual({ ['__proto__']: '1000', constructor: 1001, TITLE: 'Bob\'s "dev"' });
});
