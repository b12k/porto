type ErrorsByKey = Record<string, { instruction: string; message: string }>;

export const ERRORS_BY_KEY = {
  configInvalid: { instruction: 'Check porto.config.ts or porto.config.js.', message: 'Invalid Porto configuration.' },
  exportInvalid: { instruction: 'Check --json-path and --env-path filenames.', message: 'Invalid export options.' },
  hookFailed: {
    instruction: 'The registry change is already saved. Check the hook in your config.',
    message: 'Lifecycle hook failed.',
  },
  mappingInvalid: {
    instruction: 'Use unique variable names, valid callbacks, and a slot large enough for all entries.',
    message: 'Invalid variables.',
  },
  offsetInvalid: { instruction: 'Choose an integer offset inside the slot.', message: 'Invalid port offset.' },
  optionsInvalid: {
    instruction: 'Check host, start, size, and idleTtlMinutes.',
    message: 'Invalid reservation options.',
  },
  portsBusy: {
    instruction: 'Stop the services using these ports and try again.',
    message: 'Cannot release reservations while ports are in use.',
  },
  rangeMismatch: {
    instruction: 'Use the repository start and size, or release all slots before changing them.',
    message: 'Port range settings differ from the repository registry.',
  },
  registryInvalid: {
    instruction: 'Restore or repair the slot file before continuing.',
    message: 'Cannot read reservation.',
  },
  reservationNotFound: {
    instruction: 'Run porto show --all to list slots or porto reserve to reserve one.',
    message: 'No matching port slot.',
  },
  slotIndexInvalid: { instruction: 'Choose a non-negative integer slot index.', message: 'Invalid slot index.' },
  slotSelectionInvalid: {
    instruction: 'Use a slot number or --all.',
    message: 'Cannot combine a slot number with --all.',
  },
  slotUnavailable: {
    instruction: 'Release unused slots or choose another range.',
    message: 'No free port slot remains in the TCP port range.',
  },
  worktreeNotFound: {
    instruction: 'Run Porto inside a regular Git worktree.',
    message: 'Porto must run inside a Git working tree.',
  },
} as const satisfies ErrorsByKey;
