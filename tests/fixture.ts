import { listBusyPorts } from '../src/ports';

export async function fetchFreeRange(size: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const start = 20_000 + Math.floor(Math.random() * 20_000);
    // Test workers share the machine's port space; try another range when one is busy.
    // oxlint-disable-next-line no-await-in-loop
    const busyPorts = await listBusyPorts(start, start + size - 1);
    if (busyPorts.length === 0) return start;
  }
  throw new Error('Cannot find a free test port range.');
}
