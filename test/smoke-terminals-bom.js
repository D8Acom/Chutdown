#!/usr/bin/env node
'use strict'
const assert = require('assert')

const { parseTerminalsFile } = require('../src/terminals')

;(function () {
  try {
    // JSON-style payload with a leading UTF-8 BOM
    const bom = '\uFEFF'
    const jsonPayload = bom + JSON.stringify({ web: { cmd: 'npm run dev', cwd: '.', port: 3000 } }, null, 2)
    const jsonEntries = parseTerminalsFile(jsonPayload)
    assert.ok(Array.isArray(jsonEntries), 'expected array from JSON payload')
    const webJson = jsonEntries.find(e => e.name === 'web')
    assert.ok(webJson, 'expected entry named "web" from JSON payload')
    assert.strictEqual(webJson.command, 'npm run dev', 'unexpected command for web (JSON)')
    console.log('ok - JSON .terminals with BOM parsed and contains web')

    // Line-syntax payload with a leading UTF-8 BOM
    const linePayload = bom + 'web = npm run dev\n'
    const lineEntries = parseTerminalsFile(linePayload)
    assert.ok(Array.isArray(lineEntries), 'expected array from line payload')
    const webLine = lineEntries.find(e => e.name === 'web')
    assert.ok(webLine, 'expected entry named "web" from line payload')
    assert.strictEqual(webLine.command, 'npm run dev', 'unexpected command for web (line)')
    console.log('ok - line .terminals with BOM parsed and contains web')

    console.log('smoke-terminals-bom: done')
  } catch (err) {
    console.error('FAIL - smoke-terminals-bom:', err && err.message)
    process.exit(1)
  }
})()
