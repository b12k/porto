import { expect, it } from '@rstest/core';
import { setImmediate } from 'node:timers/promises';

import type { Vars } from '../src/vars';

import { PortoError } from '../src/error';
import { buildBlock } from '../src/ports';
import { mapBlockToVars, parseVars, validateVars, VARS_SCHEMA } from '../src/vars';

it('assigns each flattened variable its indexed port, including block-only factories', () => {
  const portBlock = buildBlock({ index: 2, size: 4, start: 1000 });
  const vars: Vars = [
    'API_PORT',
    {
      CLIENT_HOST(block) {
        return `wt${block}.localhost`;
      },
      CLIENT_URL(block, port, idx) {
        return `http://wt${block}.localhost:${port}/${idx}`;
      },
    },
    'LAST_PORT',
  ];
  expect(mapBlockToVars(portBlock, vars)).toEqual({
    API_PORT: 1008,
    CLIENT_HOST: 'wt2.localhost',
    CLIENT_URL: 'http://wt2.localhost:1010/2',
    LAST_PORT: 1011,
  });
});

it('uses the same indexed semantics for CLI templates and structured vars', () => {
  const block = buildBlock({ index: 2, size: 4, start: 1000 });
  const vars = parseVars('API_PORT;CLIENT_HOST:wt{{block}}.localhost;URL:http://localhost:{{port}}/{{port}};LAST_PORT');
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
    return `wt${block}.localhost`;
  }
  const vars = validateVars([{ HOST: createHost }], 1);
  expect(callsCount).toBe(0);
  expect(vars[0]).toHaveProperty('HOST', createHost);
  expect(mapBlockToVars(buildBlock({ index: 2, size: 1, start: 1000 }), vars)).toEqual({ HOST: 'wt2.localhost' });
  expect(callsCount).toBe(1);
});

it('rejects invalid names, duplicates and multiline CLI templates', () => {
  expect(() => parseVars('BAD-NAME')).toThrow(PortoError);
  expect(() => parseVars('')).toThrow(PortoError);
  expect(() => parseVars('A;A')).toThrow(PortoError);
  expect(() => parseVars('A;')).toThrow(PortoError);
  expect(() => parseVars('A:line\nnext')).toThrow(PortoError);
  expect(VARS_SCHEMA.safeParse([{ API_PORT: 42 }]).success).toBe(false);
  expect(
    VARS_SCHEMA.safeParse([
      'API_PORT',
      {
        API_PORT() {
          return 'duplicate';
        },
      },
    ]).success,
  ).toBe(false);
});

it('checks flattened variable count before calling factories', () => {
  let callsCount = 0;
  const vars: Vars = [
    {
      FIRST() {
        callsCount += 1;
        return 'a';
      },
      SECOND() {
        return 'b';
      },
    },
  ];
  expect(() => validateVars(vars, 1)).toThrow(PortoError);
  expect(() => mapBlockToVars(buildBlock({ index: 0, size: 1, start: 1000 }), vars)).toThrow(PortoError);
  expect(callsCount).toBe(0);
});

it.each([42, 'line\nnext', 'line\rnext', 'nul\0byte'])(
  'rejects a factory result that is not a single-line string: %s',
  (returned) => {
    const vars = VARS_SCHEMA.parse([
      {
        TITLE() {
          return returned;
        },
      },
    ]);
    expect(() => mapBlockToVars(buildBlock({ index: 0, size: 1, start: 1000 }), vars)).toThrow(PortoError);
  },
);

it('wraps factory errors with a variable name and the original cause', () => {
  const factoryError = new Error('Factory failed.');
  let mappingError: unknown;
  try {
    mapBlockToVars(buildBlock({ index: 0, size: 1, start: 1000 }), [
      {
        TITLE() {
          throw factoryError;
        },
      },
    ]);
  } catch (error) {
    mappingError = error;
  }
  expect(mappingError).toBeInstanceOf(PortoError);
  expect(mappingError).toHaveProperty('code', 'mappingInvalid');
  expect(mappingError).toHaveProperty('cause', factoryError);
  expect(mappingError).toHaveProperty('message', expect.stringContaining('TITLE'));
});

it('rejects async factories without leaving an unhandled rejection', async () => {
  let callsCount = 0;
  const vars = VARS_SCHEMA.parse([
    {
      async TITLE() {
        callsCount += 1;
        await setImmediate();
        throw new Error('Async factory failed.');
      },
    },
  ]);
  expect(() => mapBlockToVars(buildBlock({ index: 0, size: 1, start: 1000 }), vars)).toThrow(PortoError);
  await setImmediate();
  expect(callsCount).toBe(1);
});

it('preserves special property names and JSON-compatible template strings', () => {
  const block = buildBlock({ index: 0, size: 3, start: 1000 });
  const vars = parseVars('__proto__:{{port}};constructor;TITLE:Bob\'s "dev"');
  const environment = mapBlockToVars(block, vars);
  expect(Object.hasOwn(environment, '__proto__')).toBe(true);
  expect(environment).toEqual({ ['__proto__']: '1000', constructor: 1001, TITLE: 'Bob\'s "dev"' });
});
