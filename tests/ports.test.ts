import { afterEach, expect, it } from '@rstest/core';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

import { LOOPBACK_HOST } from '../src/config';
import { listBusyPorts } from '../src/ports';
import { fetchFreeRange } from './fixture';

const interfaces = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
  (addresses ?? []).map((address) => Object.assign(address, { name })),
);
const ipv4Host = interfaces.find((address) => address.family === 'IPv4' && !address.internal)?.address;
const servers: Array<ReturnType<typeof createServer>> = [];

async function closeListener(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

async function createListener(host?: string) {
  const server = createServer();
  servers.push(server);
  if (host === undefined) server.listen({ port: 0 });
  else server.listen({ host, port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Missing server address.');
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeListener(server)));
});

it('reports a free range as free on loopback', async () => {
  const start = await fetchFreeRange(4);
  expect(await listBusyPorts(start, start + 3, { host: LOOPBACK_HOST })).toEqual([]);
});

it.skipIf(!ipv4Host)('detects a busy port on an explicitly probed IPv4 interface', async () => {
  if (!ipv4Host) throw new Error('Missing IPv4 interface.');
  const port = await createListener(ipv4Host);
  expect(await listBusyPorts(port, port, { host: ipv4Host })).toEqual([port]);
});

it('detects a wildcard listener through the loopback probe', async () => {
  // A default listen() binds the wildcard address like a typical dev server
  // (express, vite); probing 127.0.0.1 must still report the port as busy.
  const port = await createListener();
  expect(await listBusyPorts(port, port, { host: LOOPBACK_HOST })).toEqual([port]);
});
