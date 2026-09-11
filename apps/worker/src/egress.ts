import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { resolvePublic, publicUrl } from '../../../packages/runtime/src/network.ts';
/** DNS is resolved and checked at each tunnel, then the verified IP is pinned to the socket. */
export async function startEgressProxy() {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(120000, () => socket.destroy());
  });
  server.on('connect', async (req, client, head) => {
    try {
      const u = publicUrl(`https://${req.url}`);
      const address = await resolvePublic(u.hostname);
      if (client.destroyed) return;
      const upstream = connect({ host: address.address, port: 443, family: address.family });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.setTimeout(120000, () => upstream.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
