import { expect, it } from '@rstest/core';

import { applyReserveDefaults, parseConfig } from '../src/config';
import { defineConfig, PortoError, reserve } from '../src/index';
import { formatEnvironment } from '../src/output';
import { buildBlock } from '../src/ports';
import { assertVarsFit, mapBlockToVars, parseVars } from '../src/vars';

it('applies reservation and output defaults without enabling the default env filename', () => {
  expect(applyReserveDefaults(parseConfig({}))).toEqual({
    env: false,
    envFile: '.env',
    idleTtlMinutes: 60,
    jsonFile: false,
    size: 10,
    start: 10_000,
  });
});

it('enables env for an explicit filename unless explicitly disabled', () => {
  expect(parseConfig({ envFile: 'custom.env' })).toMatchObject({ env: true, envFile: 'custom.env' });
  expect(parseConfig({ env: false, envFile: 'custom.env' })).toMatchObject({ env: false });
  expect(() => parseConfig({ envFile: '' })).toThrow(PortoError);
  expect(() => parseConfig({ envFile: true })).toThrow(PortoError);
});

it('rejects the CLI-only json flag in config', () => {
  expect(() => parseConfig({ json: true })).toThrow(PortoError);
});

it('validates hooks without executing them and infers their block arguments', () => {
  let callsCount = 0;
  const config = defineConfig({
    onReleased(block, ports) {
      callsCount += ports[0] ?? block.start;
    },
    onReserved(block, ports) {
      callsCount += block.getPort() + ports.reduce((total, port) => total + port, 0);
    },
  });
  const settings = parseConfig(config);
  expect(settings.onReleased).toBe(config.onReleased);
  expect(settings.onReserved).toBe(config.onReserved);
  expect(callsCount).toBe(0);
  expect(() => parseConfig({ onReserved: 'command' })).toThrow(PortoError);
  expect(() => parseConfig({ onReleased: 42 })).toThrow(PortoError);
});

it('validates library options through the Porto error system', async () => {
  const failure = reserve({ size: 0 });
  await expect(failure).rejects.toBeInstanceOf(PortoError);
  await expect(failure).rejects.toHaveProperty('code', 'optionsInvalid');
  await expect(reserve({ size: 2, start: 65_535 })).rejects.toThrow('size');
  await expect(reserve({ idleTtlMinutes: 0 })).rejects.toThrow('idleTtlMinutes');
  await expect(reserve({ host: ' ' })).rejects.toThrow('host');
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
  expect(() => {
    assertVarsFit(parseVars('A;B;C;D').length, 3);
  }).toThrow(PortoError);
  expect(formatEnvironment({ TITLE: 'a # b' })).toBe("TITLE='a # b'");
});
