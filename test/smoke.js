'use strict';
const assert = require('assert');
const path = require('path');

// Minimal mock of src/shared so src/terminals can be required in plain Node
const logs = [];
const mockShared = {
  nlog: (...args) => logs.push(args.join(' ')),
  state: { extContext: { extension: { id: 'd8a.chutdown' } } }
};

// Inject into require.cache at the resolved id so require('./src/terminals') picks it up
const sharedId = require.resolve('./src/shared.js');
require.cache[sharedId] = { id: sharedId, filename: sharedId, loaded: true, exports: mockShared };

const terminals = require('./src/terminals');
const { parseTerminalsFile, sampleJson } = terminals;

function resetLogs() { logs.length = 0; }
function hasLog(substr) { return logs.some((l) => String(l).includes(substr)); }

try {
  // 1) Line syntax parsing and @/sub parsing
  resetLogs();
  const text1 = 'web:3003 @ D8A = npm run dev\n# comment\napi = npm start';
  const e1 = parseTerminalsFile(text1);
  assert.strictEqual(e1.length, 2, 'expected two entries from line syntax');
  assert.strictEqual(e1[0].name, 'web:3003');
  assert.strictEqual(e1[0].sub, 'D8A');
  assert.strictEqual(e1[0].command, 'npm run dev');

  // 2) BOM stripping (leading U+FEFF)
  resetLogs();
  const bom = '\uFEFF';
  const e2 = parseTerminalsFile(bom + 'web = npm run dev');
  assert.strictEqual(e2.length, 1);
  assert.strictEqual(e2[0].name, 'web');

  // 3) JSON parsing with comments and trailing commas, and port validation
  resetLogs();
  const jsonText = '{\n  "// note": "x",\n  "web": { "cmd": "npm run dev", "port": 3003 },\n  "bad": { "cmd": "npm start", "port": 70000 },\n}';
  const e3 = parseTerminalsFile(jsonText);
  const web = e3.find((r) => r.name === 'web');
  const bad = e3.find((r) => r.name === 'bad');
  assert.ok(web, 'web entry present');
  assert.strictEqual(web.port, 3003);
  assert.ok(bad, 'bad entry present');
  assert.strictEqual(bad.port, undefined, 'out-of-range port should be ignored');
  assert.ok(hasLog('is not a port'), 'expected log about invalid port');

  // 4) Duplicate-name rejection in line syntax
  resetLogs();
  const dup = 'web = npm run dev\nweb = npm start';
  const e4 = parseTerminalsFile(dup);
  assert.strictEqual(e4.length, 1, 'duplicate name should be ignored');
  assert.ok(hasLog('is listed twice'), 'expected duplicate-name log');

  // 5) Malformed JSON yields an error with a line/column reported
  resetLogs();
  const badJson = '{\n  "web": "oops\n  "api": "x"\n}';
  let threw = false;
  try { parseTerminalsFile(badJson); }
  catch (err) { threw = true; assert.ok(/line\s+2/i.test(err.message), 'error should include line 2'); }
  assert.ok(threw, 'malformed JSON should throw');

  // 6) sampleJson returns the sample text and includes the example entry
  const sample = sampleJson('/some/folder');
  assert.ok(/"\/\/ web"/.test(sample) || /"\/\/ web":/.test(sample), 'sampleJson should include the example web entry');

  console.log('PASS: all smoke checks');
  process.exit(0);
} catch (err) {
  console.error('FAIL:', err && (err.stack || err.message || err));
  // print captured logs to help debugging
  if (logs.length) console.error('Captured logs:\n' + logs.join('\n'));
  process.exit(1);
}
