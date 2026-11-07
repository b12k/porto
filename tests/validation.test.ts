import { expect, it } from '@rstest/core';

import { PortoError, reserve } from '../src/index';
import { formatEnvironment } from '../src/output';
import { buildBlock } from '../src/ports';
import { mapBlockToVars, parseVars } from '../src/vars';

it('validates library options through the Porto error system', async () => {
  const failure = reserve({ size: 0 });
  await expect(failure).rejects.toBeInstanceOf(PortoError);
  await expect(failure).rejects.toHaveProperty('code', 'optionsInvalid');
  await expect(reserve({ size: 2, start: 65_535 })).rejects.toThrow('size');
  await expect(reserve({ idleTtlMinutes: 0 })).rejects.toThrow('idleTtlMinutes');
  await expect(reserve({ start: Number.NaN })).rejects.toThrow('start');
});

it('calculates inclusive block bounds and validates getPort offsets', () => {
  const block = buildBlock({ index: 2, size: 10, start: 1000 });
  expect({ end: block.end, index: block.index, start: block.start }).toEqual({ end: 1029, index: 2, start: 1020 });
  expect(block.getPort()).toBe(1020);
  expect(block.getPort(9)).toBe(1029);
  expect(() => block.getPort(-1)).toThrow(PortoError);
  expect(() => block.getPort(10)).toThrow(PortoError);
  expect(() => block.getPort(0.5)).toThrow(PortoError);
});

it('handles special variable names, template ports and env quoting', () => {
  const block = buildBlock({ index: 2, size: 3, start: 1000 });
  expect(mapBlockToVars(block, parseVars('__proto__;HOST:wt{{block}}'))).toEqual({ ['__proto__']: 1006, HOST: 'wt2' });
  expect(mapBlockToVars(block, parseVars('HOST:wt{{block}};API;URL:{{port}}/{{port}}'))).toEqual({
    API: 1007,
    HOST: 'wt2',
    URL: '1008/1008',
  });
  expect(() => mapBlockToVars(block, parseVars('A;B;C;D'))).toThrow(PortoError);
  expect(formatEnvironment({ TITLE: 'a # b' })).toBe("TITLE='a # b'");
});
