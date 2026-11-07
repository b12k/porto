import { afterEach, expect, it } from '@rstest/core';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

import { listBusyPorts } from '../src/ports';

const interfaces = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
  (addresses ?? []).map((address) => Object.assign(address, { name })),
);
const ipv4Host = interfaces.find((address) => address.family === 'IPv4' && !address.internal)?.address;
const ipv6Interface = interfaces.find((address) => address.family === 'IPv6' && address.scopeid > 0);
const ipv6Host =
  ipv6Interface?.family === 'IPv6'
    ? `${ipv6Interface.address}%${process.platform === 'win32' ? ipv6Interface.scopeid : ipv6Interface.name}`
    : undefined;
const servers: ReturnType<typeof createServer>[] = [];

async function closeListener(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

async function createListener(host: string) {
  const server = createServer();
  servers.push(server);
  server.listen({ host, ipv6Only: true, port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Missing server address.');
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => closeListener(server)));
});

it.skipIf(!ipv4Host)('detects a busy port bound to a local IPv4 interface', async () => {
  if (!ipv4Host) throw new Error('Missing IPv4 interface.');
  const port = await createListener(ipv4Host);
  expect(await listBusyPorts(port, port)).toEqual([port]);
});

it.skipIf(!ipv6Host)('detects a busy port bound to a scoped local IPv6 interface', async () => {
  if (!ipv6Host) throw new Error('Missing scoped IPv6 interface.');
  const port = await createListener(ipv6Host);
  expect(await listBusyPorts(port, port)).toEqual([port]);
});
