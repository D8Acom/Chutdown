const assert = require('assert');

const win = require('../src/platform/win32');
const mac = require('../src/platform/darwin');

const platforms = [
  { name: 'win32', mod: win },
  { name: 'darwin', mod: mac }
];

const unsafePids = [0, 1, process.pid, process.ppid];
const benignPid = 12345;

for (const p of platforms) {
  const name = p.name;
  const mod = p.mod;
  const fn = mod.killTreeCommand;
  if (typeof fn !== 'function') {
    console.log(`${name}: killTreeCommand not exported, skipping`);
    continue;
  }

  // Unsafe pids must return the empty string on every platform
  for (const bad of unsafePids) {
    const out = fn(bad);
    try {
      assert.strictEqual(out, '', `${name}: expected empty string for unsafe pid ${bad}, got ${String(out)}`);
      console.log(`ok - ${name} refused pid ${bad}`);
    } catch (err) {
      console.error(`FAIL - ${name} unsafe pid ${bad}:`, err.message);
      process.exit(1);
    }
  }

  // Benign pid should produce a non-empty string that includes the pid
  const good = fn(benignPid);
  try {
    assert.ok(typeof good === 'string' && good.length > 0, `${name}: benign pid should produce a non-empty string`);
    assert.ok(String(good).includes(String(benignPid)), `${name}: benign pid output should include the pid`);
    console.log(`ok - ${name} produced command for benign pid ${benignPid}`);
  } catch (err) {
    console.error(`FAIL - ${name} benign pid ${benignPid}:`, err.message);
    process.exit(1);
  }
}

console.log('smoke-kill-tree: done');
