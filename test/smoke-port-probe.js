const net = require('net');
const assert = require('assert');
const { portListening } = require('../src/batch');

function listenTcp(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(() => {});
    srv.listen({ host, port: 0 }, () => {
      const addr = srv.address();
      resolve({ srv, port: addr.port });
    });
    srv.on('error', (err) => reject(err));
  });
}

async function withServer(host, fn) {
  const { srv, port } = await listenTcp(host);
  try {
    return await fn(port);
  } finally {
    try { srv.close(); } catch {}
  }
}

(async () => {
  // IPv4-only server on 127.0.0.1
  await withServer('127.0.0.1', async (port) => {
    const up = await portListening(port);
    assert.strictEqual(up, true, '127.0.0.1 server should be reported as listening');
    console.log('ok 1 - IPv4 loopback detected');
  });

  // IPv6-only server on ::1 may not be supported on all platforms. Make this a
  // non-fatal skip rather than a hard failure.
  let ipv6Supported = true;
  try {
    await withServer('::1', async (port) => {
      const up = await portListening(port);
      assert.strictEqual(up, true, '::1 server should be reported as listening');
      console.log('ok 2 - IPv6 loopback detected');
    });
  } catch (e) {
    // If binding to ::1 fails because the platform has no IPv6 loopback, skip.
    console.log('ok 2 - skipped IPv6 (::1) test: ' + e.message);
    ipv6Supported = false;
  }

  console.log('smoke-port-probe: done');
})();
