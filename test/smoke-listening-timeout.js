#!/usr/bin/env node
'use strict'
const assert = require('assert')

// Patch the platform module before loading src/batch so the module cache in Node
// hands the patched object to batch when it requires('./platform').
const platform = require('../src/platform')
// Make listeningPids never resolve so the LISTEN_PID_TIMEOUT_MS path is taken.
platform.listeningPids = function () {
  return new Promise(() => {})
}

const { killPort } = require('../src/batch')

;(async () => {
  const start = Date.now()
  try {
    const res = await killPort(1)
    const elapsed = Date.now() - start

    try {
      assert.strictEqual(typeof res, 'object', 'expected result object')
      assert.strictEqual(res.killed, 0, 'expected killed === 0 when listeningPids times out')
      assert.ok(Array.isArray(res.stillHeld), 'stillHeld must be an array')

      // The timeout in src/batch.js is currently 7000ms. Allow some leeway: the
      // call should not return almost instantly, and it should complete within a
      // short bound so the smoke suite does not hang forever if the wrapper works.
      const min = 6000
      const max = 11000
      assert.ok(elapsed >= min, `expected elapsed >= ${min}ms (was ${elapsed}ms)`) 
      assert.ok(elapsed < max, `expected elapsed < ${max}ms (was ${elapsed}ms)`) 

      console.log('ok - killPort returned after listeningPids timeout with killed === 0')
    } catch (e) {
      console.error('FAIL - assertion:', e && e.message)
      process.exit(1)
    }
  } catch (e) {
    console.error('FAIL - killPort rejected or hung:', e && e.message)
    process.exit(1)
  }

  console.log('smoke-listening-timeout: done')
})()
