#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const dir = __dirname
const me = path.basename(__filename)

function listTests() {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.js'))
      .filter(f => f !== me)
      .map(f => path.join(dir, f))
      .sort()
  } catch (err) {
    console.error('Failed to read test directory:', err)
    process.exit(2)
  }
}

async function runTest(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit' })
    child.on('close', (code, signal) => resolve({ file, code, signal }))
    child.on('error', (err) => resolve({ file, code: 2, signal: null, error: err }))
  })
}

;(async function main() {
  const tests = listTests()
  if (tests.length === 0) {
    console.log('No smoke tests found in', dir)
    process.exit(0)
  }

  console.log('Running', tests.length, 'smoke test(s):')
  tests.forEach(t => console.log('- ' + path.basename(t)))

  const results = []
  for (const t of tests) {
    console.log('\n=== RUN', path.basename(t), '===')
    // run each in isolation, forward stdio
    // eslint-disable-next-line no-await-in-loop
    const res = await runTest(t)
    results.push(res)
    const { code, signal, file, error } = res
    if (error) {
      console.error(`Test ${path.basename(file)} failed to start:`, error)
    } else if (signal) {
      console.error(`Test ${path.basename(file)} terminated with signal ${signal}`)
    } else {
      console.log(`Test ${path.basename(file)} exited with code ${code}`)
    }
  }

  const failed = results.filter(r => r.code && r.code !== 0 || r.signal || r.error)

  console.log('\nSummary:')
  for (const r of results) {
    const name = path.basename(r.file)
    if (r.error) console.log(`- ${name}: ERROR (${r.error && r.error.message})`)
    else if (r.signal) console.log(`- ${name}: SIGNAL ${r.signal}`)
    else console.log(`- ${name}: exit ${r.code}`)
  }

  if (failed.length > 0) {
    console.error('\nOne or more smoke tests failed')
    process.exit(1)
  }

  console.log('\nAll smoke tests passed')
  process.exit(0)
})()
