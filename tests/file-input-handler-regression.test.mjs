import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('../bilibili_follower_snapshot_public.js', import.meta.url);
const source = (await readFile(sourceUrl, 'utf8')).replaceAll('\r\n', '\n');
const startMarker =
  "ui.loadBaseline.addEventListener('change', async (event) => {";
const endMarker =
  "\n  });\n\n  ui.saveCompareJson.addEventListener('click'";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

assert.notEqual(start, -1, 'loadBaseline change handler must exist');
assert.notEqual(end, -1, 'loadBaseline change handler end must exist');

const handlerBody = source.slice(start + startMarker.length, end);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const handler = new AsyncFunction(
  'event',
  'state',
  'uniqueByUid',
  'normalizeFollower',
  'log',
  'setStatus',
  'enableExportButtons',
  handlerBody
);

function uniqueByUid(items) {
  const map = new Map();
  for (const item of items) {
    if (item?.uid && !map.has(item.uid)) map.set(item.uid, item);
  }
  return [...map.values()];
}

function normalizeFollower(item) {
  const uid = Number(item?.uid ?? item?.mid);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  return {
    ...item,
    uid,
    name: item.name ?? item.uname ?? '',
    followTime: item.followTime ?? '',
    followTimestamp: item.followTimestamp ?? item.mtime ?? null
  };
}

function makeFixture(fileText, report = null) {
  const calls = { currentTarget: 0, enable: 0, logs: [], statuses: [] };
  const file = {
    name: 'baseline.json',
    async text() {
      await Promise.resolve();
      return fileText;
    }
  };
  const input = { files: [file], value: 'C:\\fakepath\\baseline.json' };
  const event = {
    get currentTarget() {
      calls.currentTarget += 1;
      return calls.currentTarget === 1 ? input : null;
    },
    get target() {
      return null;
    }
  };
  const state = { report, comparison: { stale: true } };
  const log = (...args) => calls.logs.push(args);
  const setStatus = (...args) => calls.statuses.push(args);
  const enableExportButtons = () => {
    calls.enable += 1;
  };

  return {
    calls,
    event,
    input,
    state,
    run: () =>
      handler(
        event,
        state,
        uniqueByUid,
        normalizeFollower,
        log,
        setStatus,
        enableExportButtons
      )
  };
}

test('captures the input before await and clears it after a successful comparison', async () => {
  const baseline = {
    generatedAt: '2026-08-01T00:00:00.000Z',
    followers: [
      { uid: 1, name: 'kept' },
      { uid: 2, name: 'removed' }
    ]
  };
  const fixture = makeFixture(JSON.stringify(baseline), {
    targetUid: 123456789,
    targetName: 'fixture',
    generatedAt: '2026-08-02T00:00:00.000Z',
    followers: [
      { uid: 1, name: 'kept' },
      { uid: 3, name: 'added' }
    ]
  });

  await fixture.run();

  assert.equal(fixture.calls.currentTarget, 1);
  assert.equal(fixture.input.value, '');
  assert.equal(fixture.state.comparison.removedCount, 1);
  assert.equal(fixture.state.comparison.addedCount, 1);
  assert.equal(fixture.state.comparison.removed[0].uid, 2);
  assert.equal(fixture.state.comparison.added[0].uid, 3);
  assert.equal(fixture.calls.enable, 1);
});

test('clears the input after invalid JSON without masking the parse error', async () => {
  const fixture = makeFixture('{ invalid json', {
    targetUid: 123456789,
    targetName: 'fixture',
    generatedAt: '2026-08-02T00:00:00.000Z',
    followers: []
  });

  await fixture.run();

  assert.equal(fixture.calls.currentTarget, 1);
  assert.equal(fixture.input.value, '');
  assert.equal(fixture.state.comparison, null);
  assert.equal(fixture.calls.enable, 1);
  assert.match(fixture.calls.statuses.at(-1)[0], /旧快照读取失败/);
});

test('clears an early import selection when no current report exists', async () => {
  const fixture = makeFixture('{"followers":[]}', null);

  await fixture.run();

  assert.equal(fixture.calls.currentTarget, 1);
  assert.equal(fixture.input.value, '');
  assert.deepEqual(fixture.state.comparison, { stale: true });
});
