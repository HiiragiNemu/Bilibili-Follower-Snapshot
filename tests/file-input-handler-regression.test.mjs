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
  'validateSnapshotForComparison',
  'log',
  'setStatus',
  'enableExportButtons',
  handlerBody
);

const validatorStartMarker =
  '  function validateSnapshotForComparison(report, label) {';
const validatorEndMarker = '\n\n  async function fetchJson';
const validatorStart = source.indexOf(validatorStartMarker);
const validatorEnd = source.indexOf(validatorEndMarker, validatorStart);

assert.notEqual(validatorStart, -1, 'snapshot validator must exist');
assert.notEqual(validatorEnd, -1, 'snapshot validator end must exist');

const validatorSource = source.slice(validatorStart, validatorEnd).trim();

function uniqueByUid(items) {
  const map = new Map();
  for (const item of items) {
    if (item?.uid && !map.has(item.uid)) map.set(item.uid, item);
  }
  return [...map.values()];
}

function normalizeUid(value) {
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
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

const validateSnapshotForComparison = new Function(
  'normalizeUid',
  'normalizeFollower',
  'uniqueByUid',
  `${validatorSource}; return validateSnapshotForComparison;`
)(normalizeUid, normalizeFollower, uniqueByUid);

function makeCompleteReport({
  targetUid = 123456789,
  followers = [],
  generatedAt = '2026-08-02T00:00:00.000Z',
  reportVersion = 'public-2026-08-01-v1.1'
} = {}) {
  return {
    reportType: 'bilibili-current-follower-snapshot',
    reportVersion,
    generatedAt,
    targetUid,
    targetName: 'fixture',
    initialReportedTotal: followers.length,
    listEndpointReportedTotal: followers.length,
    finalReportedTotal: followers.length,
    exportedUniqueTotal: followers.length,
    complete: true,
    followers
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
        validateSnapshotForComparison,
        log,
        setStatus,
        enableExportButtons
      )
  };
}

test('captures the input before await and clears it after a successful comparison', async () => {
  const baseline = makeCompleteReport({
    generatedAt: '2026-08-01T00:00:00.000Z',
    reportVersion: 'public-2026-08-01-v1',
    followers: [
      { uid: 1, name: 'kept' },
      { uid: 2, name: 'removed' }
    ]
  });
  const fixture = makeFixture(JSON.stringify(baseline), makeCompleteReport({
    followers: [
      { uid: 1, name: 'kept' },
      { uid: 3, name: 'added' }
    ]
  }));

  await fixture.run();

  assert.equal(fixture.calls.currentTarget, 1);
  assert.equal(fixture.input.value, '');
  assert.equal(fixture.state.comparison.removedCount, 1);
  assert.equal(fixture.state.comparison.addedCount, 1);
  assert.equal(fixture.state.comparison.removed[0].uid, 2);
  assert.equal(fixture.state.comparison.added[0].uid, 3);
  assert.equal(
    fixture.state.comparison.reportVersion,
    'public-comparison-2026-08-09-v1.1'
  );
  assert.equal(fixture.state.comparison.previousComplete, true);
  assert.equal(fixture.state.comparison.currentComplete, true);
  assert.equal(fixture.state.comparison.previousReportedTotal, 2);
  assert.equal(fixture.state.comparison.currentReportedTotal, 2);
  assert.equal(fixture.state.comparison.previousExportedUniqueTotal, 2);
  assert.equal(fixture.state.comparison.currentExportedUniqueTotal, 2);
  assert.equal(fixture.state.comparison.confidence, 'high');
  assert.equal(fixture.state.comparison.validity.valid, true);
  assert.equal(fixture.calls.enable, 1);
});

test('clears the input after invalid JSON without masking the parse error', async () => {
  const fixture = makeFixture('{ invalid json', makeCompleteReport());

  await fixture.run();

  assert.equal(fixture.calls.currentTarget, 1);
  assert.equal(fixture.input.value, '');
  assert.equal(fixture.state.comparison, null);
  assert.equal(fixture.calls.enable, 1);
  assert.match(fixture.calls.statuses.at(-1)[0], /快照比较已停止/);
});

test('clears an early import selection when no current report exists', async () => {
  const fixture = makeFixture('{"followers":[]}', null);

  await fixture.run();

  assert.equal(fixture.calls.currentTarget, 1);
  assert.equal(fixture.input.value, '');
  assert.equal(fixture.state.comparison, null);
  assert.equal(fixture.calls.enable, 1);
  assert.match(fixture.calls.statuses.at(-1)[0], /当前快照尚未生成/);
});

test('rejects the observed 1000-of-1065 current snapshot before diffing', async () => {
  const followers = Array.from({ length: 1000 }, (_, index) => ({
    uid: index + 1,
    name: `current-${index + 1}`
  }));
  const current = {
    ...makeCompleteReport({ followers }),
    initialReportedTotal: 1065,
    listEndpointReportedTotal: 1065,
    finalReportedTotal: 1065,
    complete: false
  };
  const fixture = makeFixture(
    JSON.stringify(makeCompleteReport({ followers: followers.slice(0, 963) })),
    current
  );

  await fixture.run();

  assert.equal(fixture.state.comparison, null);
  assert.equal(fixture.input.value, '');
  assert.match(fixture.calls.statuses.at(-1)[0], /当前快照不完整/);
  assert.match(fixture.calls.statuses.at(-1)[0], /实际 1000 \/ 报告 1065/);
  assert.equal(fixture.calls.logs.some(([message]) => /比较完成/.test(message)), false);
});

test('rejects an incomplete old snapshot before producing removed or added', async () => {
  const old = {
    ...makeCompleteReport({ followers: [{ uid: 1 }] }),
    finalReportedTotal: 2,
    complete: false
  };
  const fixture = makeFixture(
    JSON.stringify(old),
    makeCompleteReport({ followers: [{ uid: 1 }] })
  );

  await fixture.run();

  assert.equal(fixture.state.comparison, null);
  assert.equal(fixture.input.value, '');
  assert.match(fixture.calls.statuses.at(-1)[0], /旧快照不完整/);
});

test('rejects snapshots belonging to different target UIDs', async () => {
  const fixture = makeFixture(
    JSON.stringify(makeCompleteReport({
      targetUid: 987654321,
      followers: [{ uid: 1 }]
    })),
    makeCompleteReport({ followers: [{ uid: 1 }] })
  );

  await fixture.run();

  assert.equal(fixture.state.comparison, null);
  assert.equal(fixture.input.value, '');
  assert.match(fixture.calls.statuses.at(-1)[0], /快照账号不一致/);
});

test('rejects count metadata that disagrees with the unique UID list', async () => {
  const countCases = [
    ['current exported count', 'current', 'exportedUniqueTotal'],
    ['old final count', 'old', 'finalReportedTotal'],
    ['old initial count', 'old', 'initialReportedTotal']
  ];

  for (const [caseName, side, field] of countCases) {
    const current = makeCompleteReport({ followers: [{ uid: 1 }] });
    const old = makeCompleteReport({ followers: [{ uid: 1 }] });
    (side === 'current' ? current : old)[field] = 2;
    const fixture = makeFixture(JSON.stringify(old), current);

    await fixture.run();

    assert.equal(fixture.state.comparison, null, caseName);
    assert.equal(fixture.input.value, '', caseName);
    assert.match(fixture.calls.statuses.at(-1)[0], /计数不一致/, caseName);
  }
});

test('rejects contradictory mobile completeness metadata', async () => {
  const mobileBase = {
    ...makeCompleteReport({ followers: [{ uid: 1 }, { uid: 2 }] }),
    reportVersion: 'mobile-test-0.2.0',
    listEndpointReportedTotals: [2, 2],
    reportedTotalForCoverage: 2,
    integrity: {
      scanWindowCountStable: true,
      unifiedReportedTotal: 2,
      listEndpointTotalsStable: true,
      listTotalsAgreeWithStat: true,
      exactUniqueTotal: true,
      uniqueCoverage: true,
      overCoverage: false,
      underCoverage: false
    }
  };
  const cases = [
    {
      name: 'plural page total mismatch',
      mutate(report) {
        report.listEndpointReportedTotals = [2, 3];
      },
      pattern: /listEndpointReportedTotals\[1\]=3/
    },
    {
      name: 'coverage total mismatch',
      mutate(report) {
        report.reportedTotalForCoverage = 3;
      },
      pattern: /reportedTotalForCoverage=3/
    },
    {
      name: 'integrity flag mismatch',
      mutate(report) {
        report.integrity.uniqueCoverage = false;
      },
      pattern: /integrity\.uniqueCoverage/
    },
    {
      name: 'integrity count mismatch',
      mutate(report) {
        report.integrity.unifiedReportedTotal = 3;
      },
      pattern: /integrity\.unifiedReportedTotal=3/
    }
  ];

  for (const fixtureCase of cases) {
    const old = structuredClone(mobileBase);
    fixtureCase.mutate(old);
    const fixture = makeFixture(
      JSON.stringify(old),
      makeCompleteReport({ followers: [{ uid: 1 }, { uid: 2 }] })
    );

    await fixture.run();

    assert.equal(fixture.state.comparison, null, fixtureCase.name);
    assert.equal(fixture.input.value, '', fixtureCase.name);
    assert.match(
      fixture.calls.statuses.at(-1)[0],
      fixtureCase.pattern,
      fixtureCase.name
    );
  }
});

test('rejects duplicate or invalid follower identities', async () => {
  const identityCases = [
    {
      name: 'duplicate UID',
      followers: [{ uid: 1 }, { uid: 1 }],
      pattern: /粉丝 UID 存在重复/
    },
    {
      name: 'invalid UID',
      followers: [{ uid: 1 }, { uid: 0 }],
      pattern: /无效的粉丝 UID/
    }
  ];

  for (const identityCase of identityCases) {
    const old = makeCompleteReport({ followers: identityCase.followers });
    const fixture = makeFixture(
      JSON.stringify(old),
      makeCompleteReport({ followers: [{ uid: 1 }, { uid: 2 }] })
    );

    await fixture.run();

    assert.equal(fixture.state.comparison, null, identityCase.name);
    assert.match(
      fixture.calls.statuses.at(-1)[0],
      identityCase.pattern,
      identityCase.name
    );
  }
});

test('retains guarded currentFollowers compatibility when completeness is provable', () => {
  const legacy = {
    reportType: 'legacy-snapshot',
    targetUid: 123456789,
    complete: true,
    currentFollowerCount: 2,
    finalReportedTotal: 2,
    currentFollowers: [{ uid: 1 }, { mid: 2 }]
  };

  const validated = validateSnapshotForComparison(legacy, '旧');

  assert.equal(validated.targetUid, 123456789);
  assert.deepEqual(validated.followers.map(({ uid }) => uid), [1, 2]);
});
