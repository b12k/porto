import type { CosmiconfigResult } from 'cosmiconfig';

import { cosmiconfig } from 'cosmiconfig';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { PortoError } from './error';
import { HOOKS_SCHEMA, OPTIONS_SCHEMA, OUTPUT_OPTIONS_SCHEMA } from './schemas';
import { VARS_SCHEMA } from './vars';

const CONFIG_FILES = ['porto.config.ts', 'porto.config.js'];
const CONFIG_SCHEMA = z
  .strictObject({ ...OPTIONS_SCHEMA.shape, ...HOOKS_SCHEMA.shape, ...OUTPUT_OPTIONS_SCHEMA.shape, vars: VARS_SCHEMA })
  .partial();

type PortoConfig = z.input<typeof CONFIG_SCHEMA>;
type ResolvedReserveConfig = ReturnType<typeof applyReserveDefaults>;

const libraryName = 'porto';
const { name, version } = packageJson;

// Layer 1 of the layered config: static defaults.
// Host and keep are absent: they inherit from the stored slot inside the lock.
const DEFAULT_CONFIG = {
  env: false,
  envFile: '.env',
  idleTtlMinutes: 60,
  jsonFile: false as false | string,
  silent: false,
  size: 10,
  start: 10_000,
};

function resolveOutputSettings(settings: Pick<PortoConfig, 'env' | 'envFile' | 'jsonFile'>) {
  return {
    env: settings.env ?? DEFAULT_CONFIG.env,
    envFile: settings.envFile ?? DEFAULT_CONFIG.envFile,
    jsonFile: settings.jsonFile ?? DEFAULT_CONFIG.jsonFile,
  };
}

function applyReserveDefaults(
  settings: Omit<PortoConfig, 'onReleased' | 'onReserved' | 'vars'>,
  storedRange: { portsPerSlot: number; startPort: number },
) {
  const size = settings.size ?? storedRange.portsPerSlot;
  const start = settings.start ?? storedRange.startPort;
  if (start + size - 1 > 65_535) {
    throw new PortoError('optionsInvalid', 'size: size must fit in the TCP port range.');
  }
  return {
    ...settings,
    ...resolveOutputSettings(settings),
    idleTtlMinutes: settings.idleTtlMinutes ?? DEFAULT_CONFIG.idleTtlMinutes,
    silent: settings.silent ?? DEFAULT_CONFIG.silent,
    size,
    start,
  };
}

function defineConfig(config: PortoConfig) {
  return config;
}

function parseConfig(config: unknown) {
  const result = CONFIG_SCHEMA.safeParse(config);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new PortoError('configInvalid', details, { cause: result.error });
  }
  const settings = result.data;
  if (settings.envFile !== undefined) settings.env ??= true;
  return settings;
}

async function fetchConfig(worktreePath: string): Promise<PortoConfig> {
  let result: CosmiconfigResult;
  try {
    result = await cosmiconfig(libraryName, { searchPlaces: CONFIG_FILES, stopDir: worktreePath }).search(
      await realpath(process.cwd()),
    );
  } catch (error) {
    throw new PortoError('configInvalid', error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (!result) return {};
  const config: unknown = result.config;
  const settings = parseConfig(
    config && typeof config === 'object' && Object.keys(config).length === 1 && 'default' in config
      ? config.default
      : config,
  );
  const directoryPath = path.dirname(result.filepath);
  for (const key of ['envFile', 'jsonFile'] as const) {
    const configuredPath = settings[key];
    if (typeof configuredPath === 'string') settings[key] = path.resolve(directoryPath, configuredPath);
  }
  return settings;
}

export {
  applyReserveDefaults,
  DEFAULT_CONFIG,
  defineConfig,
  fetchConfig,
  libraryName,
  name,
  parseConfig,
  resolveOutputSettings,
  version,
};
export type { PortoConfig, ResolvedReserveConfig };
