#!/usr/bin/env node
'use strict'
const assert = require('assert')
const { spawn } = require('child_process')
const path = require('path')

const { killPort } = require('../src/batch')

function readPortFromChild(child) {
  return new Promise((resolve, reject) => {
    let got = ''
    function onData(b) {
      got += String(b)
      const m = got.match(/(\d+)\s*\r?\n/)
      if (m) {
        cleanup()
        resolve(Number(m[1]))
      }
    }
    function onError(err) { cleanup(); reject(err) }
    function onClose(code) { cleanup(); reject(new Error('child exited before printing port: ' + code)) }
    function cleanup() {
      child.stdout.removeListener('data', onData)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
    }
    child.stdout.on('data', onData)
    child.on('error', onError)
    child.on('close', onClose)
  })
}

;(async () => {
  const fixture = path.join(__dirname, 'fixture-server.js')
  const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const port = await readPortFromChild(child)
    console.log('fixture listening on', port)

    const res = await killPort(port)
    try {
      assert.ok(typeof res === 'object', 'expected result object')
      assert.ok(res.killed === undefined || typeof res.killed === 'number')
      assert.ok(Array.isArray(res.stillHeld), 'stillHeld must be an array')
      // At least one pid killed (the fixture) and no listeners left.
      // Some platforms may present the killed count as 0 if kill was refused,
      // but then stillHeld must indicate the port is still busy; require the
      // clean case here for the smoke test to verify the reclaim logic.
      assert.ok(res.killed > 0, 'expected at least one killed process')
      assert.strictEqual(res.stillHeld.length, 0, 'expected no listeners after kill')
      console.log('ok - killPort freed the port')
    } catch (e) {
      console.error('FAIL - killPort assertion:', e && e.message)
      process.exit(1)
    }
  } finally {
    try { child.kill() } catch {}
  }

  console.log('smoke-kill-port: done')
})()
