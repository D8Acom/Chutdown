#!/usr/bin/env node
'use strict'
const net = require('net')

// A tiny server that listens on 127.0.0.1:0 and prints the chosen port to stdout
// then stays alive until killed. The smoke test spawns this script and reads the
// first line (the port number) to exercise killPort end-to-end.

const srv = net.createServer(() => {})

srv.on('error', (err) => {
  console.error('fixture-server error:', err && err.message)
  process.exit(2)
})

srv.listen({ host: '127.0.0.1', port: 0 }, () => {
  const addr = srv.address()
  if (!addr) {
    console.error('failed to determine listening address')
    process.exit(2)
  }
  // Print only the port on stdout so the parent can parse it easily.
  console.log(addr.port)
  // Keep running until killed by the test.
})
