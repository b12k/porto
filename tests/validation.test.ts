import type { IsEqual } from 'type-fest';

import { expect, it } from '@rstest/core';

import { applyReserveDefaults, parseConfig } from '../src/config';
import { defineConfig, getSlot, PortoError, releaseSlot, reserve } from '../src/index';
import { formatEnvironment } from '../src/output';
import { buildSlot } from '../src/ports';
import { assertVarsFit, mapSlotToVars, parseVars } from '../src/vars';

it('applies reservation and output defaults without enabling the default env filename', () => {
  expect(applyReserveDefaults({}, { portsPerSlot: 10, startPort: 10_000 })).toEqual({
    env: false,
    envFile: '.env',
    idleTtlMinutes: 60,
    jsonFile: false,
    silent: false,
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

it('validates hooks without executing them and infers their slot arguments', () => {
  let callsCount = 0;
  const config = defineConfig({
    onReleased(slot, ports) {
      callsCount += ports[0] ?? slot.firstPort;
    },
    onReserved(slot, ports) {
      callsCount += slot.getPort() + ports.reduce((total, port) => total + port, 0);
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
  const failure = reserve({
    size: 0,
    vars: ['PORT', 'API_PORT', (port, _slot) => ({ API_URL: `http://localhost:${port}` })],
  }).then(({ vars }) => {
    const { API_PORT, API_URL, PORT } = vars;
    const values: { API_PORT: number; API_URL: string; PORT: number } = { API_PORT, API_URL, PORT };
    return { ...values, hasExactKeys: true satisfies IsEqual<keyof typeof vars, 'API_PORT' | 'API_URL' | 'PORT'> };
  });
  await expect(failure).rejects.toBeInstanceOf(PortoError);
  await expect(failure).rejects.toHaveProperty('code', 'optionsInvalid');
  await expect(reserve({ size: 2, start: 65_535 })).rejects.toThrow('size');
  await expect(reserve({ idleTtlMinutes: 0 })).rejects.toThrow('idleTtlMinutes');
  await expect(reserve({ host: ' ' })).rejects.toThrow('host');
  await expect(reserve({ start: Number.NaN })).rejects.toThrow('start');
  await expect(
    reserve({ size: 2, vars: ['PORT', 'API_PORT', 'DB_PORT', 'WEB_PORT', 'HEALTH_PORT'] }),
  ).rejects.toHaveProperty('code', 'mappingInvalid');
});

it('reads stored slot bounds and validates getPort offsets', () => {
  const slot = buildSlot({ firstPort: 1020, lastPort: 1029 }, 2);
  expect({ firstPort: slot.firstPort, index: slot.index, lastPort: slot.lastPort }).toEqual({
    firstPort: 1020,
    index: 2,
    lastPort: 1029,
  });
  expect(slot.getPort()).toBe(1020);
  expect(slot.getPort(9)).toBe(1029);
  expect(() => slot.getPort(-1)).toThrow(PortoError);
  expect(() => slot.getPort(10)).toThrow(PortoError);
  expect(() => slot.getPort(0.5)).toThrow(PortoError);
});

it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid slot indices before reading Git state: %s',
  async (slotIndex) => {
    await expect(releaseSlot(slotIndex)).rejects.toHaveProperty('code', 'slotIndexInvalid');
    await expect(getSlot(slotIndex)).rejects.toHaveProperty('code', 'slotIndexInvalid');
  },
);

it('handles special variable names, template ports and env quoting', () => {
  const slot = buildSlot({ firstPort: 1006, lastPort: 1008 }, 2);
  expect(mapSlotToVars(slot, parseVars('__proto__;HOST=wt{{slot}}'))).toEqual({ ['__proto__']: 1006, HOST: 'wt2' });
  expect(mapSlotToVars(slot, parseVars('HOST=wt{{slot}};API;URL={{port}}/{{port}}'))).toEqual({
    API: 1007,
    HOST: 'wt2',
    URL: '1008/1008',
  });
  expect(() => {
    assertVarsFit(parseVars('A;B;C;D').length, 3);
  }).toThrow(PortoError);
  expect(formatEnvironment({ TITLE: 'a # b' })).toBe("TITLE='a # b'");
});
