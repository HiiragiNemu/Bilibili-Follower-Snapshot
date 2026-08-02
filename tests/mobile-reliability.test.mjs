import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sourceUrl = new URL(
  '../userscript/bilibili-follower-mobile-test.user.js',
  import.meta.url
);
const source = (await readFile(sourceUrl, 'utf8')).replaceAll('\r\n', '\n');
const context = {
  __BILI_FOLLOWER_MOBILE_TEST_MODE__: true,
  console,
  setTimeout,
  clearTimeout,
  URL,
  URLSearchParams,
  performance,
  AbortController
};
await vm.runInNewContext(source, context, {
  filename: 'bilibili-follower-mobile-test.user.js'
});
const core = context.__BILI_FOLLOWER_MOBILE_TEST_HOOKS__;

assert.ok(core, 'test hooks must be available in explicit test mode');

test('reported totals accept only canonical non-negative safe integers', () => {
  for (const [input, expected] of [
    [0, 0],
    [42, 42],
    ['0', 0],
    ['42', 42],
    ['9007199254740991', Number.MAX_SAFE_INTEGER]
  ]) {
    assert.equal(core.parseCanonicalNonNegativeInteger(input), expected);
  }
  for (const input of [
    null,
    undefined,
    '',
    ' ',
    '01',
    '+1',
    '-1',
    '1.0',
    '1e3',
    '9007199254740992',
    -1,
    1.5,
    Infinity,
    true
  ]) {
    assert.equal(
      core.parseCanonicalNonNegativeInteger(input),
      null,
      `must reject ${String(input)}`
    );
  }
  assert.match(
    source,
    /const follower = parseCanonicalNonNegativeInteger\(json\?\.data\?\.follower\)/
  );
  assert.match(
    source,
    /const total = parseCanonicalNonNegativeInteger\(json\.data\.total\)/
  );
});

function completeSnapshot(uid, ids, extra = {}) {
  return {
    reportType: 'bilibili-current-follower-snapshot',
    reportVersion: 'test-fixture',
    generatedAt: '2026-08-03T00:00:00.000Z',
    targetUid: uid,
    targetName: `fixture-${uid}`,
    initialReportedTotal: ids.length,
    finalReportedTotal: ids.length,
    exportedUniqueTotal: ids.length,
    complete: true,
    followers: ids.map(id => ({ uid: id, name: `user-${id}` })),
    ...extra
  };
}

test('failed endpoint round is discarded and backup restarts at page 1', async () => {
  const endpoints = [{ name: 'primary' }, { name: 'backup' }];
  const calls = [];
  const pages = {
    'primary:1': { list: [{ uid: 91 }, { uid: 92 }], total: 3 },
    'backup:1': { list: [{ uid: 1 }, { uid: 2 }], total: 3 },
    'backup:2': { list: [{ uid: 3 }], total: 3 }
  };

  const result = await core.scanFollowersWithFailover({
    uid: 123456789,
    initialTotal: 3,
    endpoints,
    pageSize: 2,
    requestDelayMs: 0,
    sleepFn: async () => {},
    async fetchPage({ endpoint, page }) {
      calls.push(`${endpoint.name}:${page}`);
      if (endpoint.name === 'primary' && page === 2) {
        throw new Error('primary page 2 exhausted retries');
      }
      const fixture = pages[`${endpoint.name}:${page}`];
      return { endpoint: endpoint.name, ...fixture };
    }
  });

  assert.deepEqual(calls, ['primary:1', 'primary:2', 'backup:1', 'backup:2']);
  assert.equal(result.endpoint, 'backup');
  assert.deepEqual(Array.from(result.followers, item => item.uid), [1, 2, 3]);
  assert.equal(result.followers.some(item => item.uid === 91 || item.uid === 92), false);
  assert.equal(result.roundAttempts.length, 2);
  assert.equal(result.roundAttempts[0].succeeded, false);
  assert.equal(result.roundAttempts[0].discardedUniqueTotal, 2);
  assert.equal(result.roundAttempts[1].succeeded, true);
});

test('short under-covered round is discarded before trying a complete backup', async () => {
  const calls = [];
  const result = await core.scanFollowersWithFailover({
    uid: 123456789,
    initialTotal: 3,
    verifiedTotal: 3,
    endpoints: [{ name: 'short-primary' }, { name: 'complete-backup' }],
    pageSize: 3,
    requestDelayMs: 0,
    sleepFn: async () => {},
    async fetchPage({ endpoint, page }) {
      calls.push(`${endpoint.name}:${page}`);
      return endpoint.name === 'short-primary'
        ? { endpoint: endpoint.name, list: [{ uid: 91 }, { uid: 92 }], total: 3 }
        : {
            endpoint: endpoint.name,
            list: [{ uid: 1 }, { uid: 2 }, { uid: 3 }],
            total: 3
          };
    }
  });

  assert.deepEqual(calls, ['short-primary:1', 'complete-backup:1']);
  assert.equal(result.endpoint, 'complete-backup');
  assert.deepEqual(Array.from(result.followers, item => item.uid), [1, 2, 3]);
  assert.equal(result.roundAttempts[0].succeeded, true);
  assert.equal(result.roundAttempts[0].coverageAccepted, false);
  assert.equal(result.roundAttempts[0].discardedDueToCoverage, true);
  assert.equal(result.roundAttempts[0].underCoverage, true);
  assert.equal(result.roundAttempts[1].coverageAccepted, true);
});

test('one missing page total rejects a round even when UID coverage is exact', async () => {
  const endpoint = { name: 'primary' };
  const result = await core.scanFollowersWithFailover({
    uid: 123456789,
    initialTotal: 3,
    verifiedTotal: 3,
    endpoints: [endpoint],
    pageSize: 2,
    requestDelayMs: 0,
    sleepFn: async () => {},
    async fetchPage({ page }) {
      return page === 1
        ? { endpoint: endpoint.name, list: [{ uid: 1 }, { uid: 2 }], total: 3 }
        : { endpoint: endpoint.name, list: [{ uid: 3 }], total: null };
    }
  });

  assert.equal(result.followers.length, 3);
  assert.equal(result.exactCoverage, true);
  assert.equal(result.allReadPagesHaveValidReportedTotal, false);
  assert.equal(result.listTotalsAgreeWithVerified, false);
  assert.equal(result.allEndpointRoundsIncomplete, true);
  assert.equal(result.roundAttempts[0].coverageAccepted, false);
});

test('GET retries use exponential backoff and record every attempt', async () => {
  const requestLog = [];
  const delays = [];
  let attempts = 0;
  const json = await core.requestJson('https://api.example.test/read', 'fixture GET', {
    requestLog,
    maxRetries: 3,
    retryBaseDelayMs: 25,
    sleepFn: async delay => delays.push(delay),
    async fetchImpl(_url, init) {
      attempts += 1;
      assert.equal(init.method, 'GET');
      if (attempts < 3) throw new Error(`network-${attempts}`);
      return {
        ok: true,
        status: 200,
        async text() {
          return '{"code":0,"data":{"ok":true}}';
        }
      };
    }
  });

  assert.equal(json.data.ok, true);
  assert.deepEqual(delays, [25, 50]);
  assert.equal(requestLog.length, 3);
  assert.deepEqual(
    Array.from(requestLog, entry => [entry.attempt, entry.ok]),
    [[1, false], [2, false], [3, true]]
  );
});

test('hanging GET is bounded and actively aborted', async () => {
  const requestLog = [];
  let signal = null;
  const startedAt = Date.now();

  await assert.rejects(
    core.requestJson('https://api.example.test/hang', 'hanging fixture', {
      requestLog,
      maxRetries: 1,
      requestTimeoutMs: 15,
      AbortControllerImpl: AbortController,
      fetchImpl(_url, init) {
        signal = init.signal;
        return new Promise(() => {});
      }
    }),
    /请求超时/
  );

  assert.ok(Date.now() - startedAt < 500, 'timeout must bound a non-settling fetch');
  assert.equal(signal.aborted, true);
  assert.equal(requestLog.length, 1);
  assert.equal(requestLog[0].timedOut, true);
  assert.equal(requestLog[0].timeoutMs, 15);
  assert.equal(requestLog[0].ok, false);
});

test('cross-account and incomplete imports are rejected without a diff', () => {
  const current = completeSnapshot(100, [1, 2]);

  assert.throws(
    () => core.compareCompleteSnapshots(completeSnapshot(200, [1]), current),
    /UID 200.*UID 100.*不一致/
  );
  assert.throws(
    () => core.compareCompleteSnapshots(
      completeSnapshot(100, [1], { complete: false }),
      current
    ),
    /complete===true/
  );
});

test('claimed complete snapshots must have one exact, internally consistent total', () => {
  assert.throws(
    () => core.validateCompleteSnapshot(
      completeSnapshot(100, [1, 2, 3], { finalReportedTotal: 4 }),
      'fixture'
    ),
    /总数互相不一致/
  );
  assert.throws(
    () => core.validateCompleteSnapshot(
      completeSnapshot(100, [1, 2, 3], {
        listEndpointReportedTotals: [3, 4]
      }),
      'fixture'
    ),
    /总数互相不一致/
  );
  assert.throws(
    () => core.validateCompleteSnapshot(
      completeSnapshot(100, [1, 2, 3, 4], {
        initialReportedTotal: 3,
        finalReportedTotal: 3,
        exportedUniqueTotal: 4
      }),
      'fixture'
    ),
    /唯一 followers 数不等于统一报告总数/
  );
  assert.throws(
    () => core.validateCompleteSnapshot(
      completeSnapshot(100, [], { initialReportedTotal: null }),
      'fixture'
    ),
    /initialReportedTotal.*有效非负整数/
  );
});

test('complete requires stable before/after stat and unique coverage', () => {
  const stableCovered = core.evaluateSnapshotIntegrity({
    initialTotal: 3,
    finalTotal: 3,
    listEndpointReportedTotals: [3],
    listEndpointTotalsStable: true,
    uniqueTotal: 3
  });
  assert.equal(stableCovered.complete, true);
  assert.equal(stableCovered.listTotalsAgreeWithStat, true);
  assert.equal(stableCovered.overCoverage, false);

  const churned = core.evaluateSnapshotIntegrity({
    initialTotal: 3,
    finalTotal: 4,
    listEndpointReportedTotals: [4],
    listEndpointTotalsStable: true,
    uniqueTotal: 4
  });
  assert.equal(churned.complete, false);
  assert.equal(churned.followerDelta, 1);

  const underCovered = core.evaluateSnapshotIntegrity({
    initialTotal: 4,
    finalTotal: 4,
    listEndpointReportedTotals: [4],
    listEndpointTotalsStable: true,
    uniqueTotal: 3
  });
  assert.equal(underCovered.complete, false);
  assert.equal(underCovered.uniqueCoverage, false);

  const overCovered = core.evaluateSnapshotIntegrity({
    initialTotal: 3,
    finalTotal: 3,
    listEndpointReportedTotals: [3],
    listEndpointTotalsStable: true,
    uniqueTotal: 4
  });
  assert.equal(overCovered.complete, false);
  assert.equal(overCovered.overCoverage, true);
  assert.equal(overCovered.listTotalsAgreeWithStat, true);

  const listTotalDrift = core.evaluateSnapshotIntegrity({
    initialTotal: 3,
    finalTotal: 3,
    listEndpointReportedTotals: [3, 4],
    listEndpointTotalsStable: false,
    uniqueTotal: 4
  });
  assert.equal(listTotalDrift.complete, false);
  assert.equal(listTotalDrift.listTotalsAgreeWithStat, false);

  const missingPageTotals = core.evaluateSnapshotIntegrity({
    initialTotal: 3,
    finalTotal: 3,
    listEndpointReportedTotals: [],
    listEndpointTotalsStable: true,
    uniqueTotal: 3
  });
  assert.equal(missingPageTotals.complete, false);
  assert.equal(missingPageTotals.listTotalsAgreeWithStat, false);
});

test('new scan and every new import invalidate stale current/diff artifacts', () => {
  const state = {
    current: { stale: true },
    comparison: { stale: true },
    requestLog: [{ stale: true }],
    warnings: ['stale'],
    errors: ['stale']
  };
  const controls = {
    saveCurrent: { disabled: false },
    saveDiff: { disabled: false }
  };

  core.invalidateForNewScan(state, controls);
  assert.equal(state.current, null);
  assert.equal(state.comparison, null);
  assert.equal(controls.saveCurrent.disabled, true);
  assert.equal(controls.saveDiff.disabled, true);
  assert.equal(state.requestLog.length, 0);
  assert.equal(state.warnings.length, 0);
  assert.equal(state.errors.length, 0);

  state.comparison = { anotherStaleDiff: true };
  controls.saveDiff.disabled = false;
  core.clearComparison(state, controls);
  assert.equal(state.comparison, null);
  assert.equal(controls.saveDiff.disabled, true);
});

test('storage failure is contained and incomplete reports never replace latest', () => {
  const report = completeSnapshot(100, [1, 2]);
  let writes = 0;
  const failingStorage = {
    getItem() {
      return null;
    },
    setItem() {
      writes += 1;
      throw new Error('quota fixture');
    }
  };

  const failed = core.tryPersistLatestComplete(report, failingStorage);
  assert.equal(writes, 1);
  assert.equal(failed.attempted, true);
  assert.equal(failed.saved, false);
  assert.match(failed.error, /quota fixture/);
  assert.equal(report.followers.length, 2, 'in-memory export data remains usable');

  const incomplete = core.tryPersistLatestComplete(
    { ...report, complete: false },
    {
      setItem() {
        writes += 1;
      }
    }
  );
  assert.equal(incomplete.attempted, false);
  assert.equal(writes, 1, 'incomplete result must not call storage.setItem');
});

test('monitor notice fingerprint de-duplicates against one persisted baseline', () => {
  const base = completeSnapshot(100, [1, 2], {
    generatedAt: '2026-08-03T01:00:00.000Z'
  });
  const changed = completeSnapshot(100, [1, 3], {
    generatedAt: '2026-08-03T02:00:00.000Z'
  });
  const first = core.compareCompleteSnapshots(base, changed);
  const repeated = core.compareCompleteSnapshots(base, {
    ...changed,
    generatedAt: '2026-08-03T02:05:00.000Z'
  });
  assert.equal(core.changeFingerprint(first), core.changeFingerprint(repeated));

  const newerBase = { ...base, generatedAt: '2026-08-03T03:00:00.000Z' };
  const recurrence = core.compareCompleteSnapshots(newerBase, changed);
  assert.notEqual(core.changeFingerprint(first), core.changeFingerprint(recurrence));
});

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  const writes = [];
  return {
    values,
    writes,
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      writes.push(key);
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('monitor persists pending comparison before advancing lastComplete', () => {
  const previous = completeSnapshot(100, [1, 2], {
    generatedAt: '2026-08-03T01:00:00.000Z'
  });
  const current = completeSnapshot(100, [1, 3], {
    generatedAt: '2026-08-03T02:00:00.000Z'
  });
  const comparison = core.compareCompleteSnapshots(previous, current);
  const storage = memoryStorage();
  const result = core.persistDetectedChangeBeforeBaseline(
    comparison,
    current,
    storage
  );

  assert.equal(result.pending.saved, true);
  assert.equal(result.baseline.saved, true);
  assert.equal(result.noticeEligible, true);
  assert.match(storage.writes[0], /PendingComparison:100:cmp-v1-/);
  assert.match(storage.writes[1], /PendingChange:100$/);
  assert.match(storage.writes[2], /LastComplete:100$/);

  const restored = core.readPendingChange(100, storage);
  assert.equal(restored.error, '');
  assert.equal(restored.envelope.comparisons.length, 1);
  assert.equal(restored.envelope.lastDetectedComparison.removed[0].uid, 2);
  assert.equal(core.readAnyPendingChange(storage).envelope.targetUid, 100);

  const repeatedArtifact = core.tryPersistPendingChange(
    comparison,
    storage,
    restored.envelope
  );
  assert.equal(repeatedArtifact.saved, true);
  assert.equal(
    repeatedArtifact.envelope.comparisons.length,
    1,
    'the same stable comparison artifact is idempotent'
  );
  const distinctComparison = {
    ...comparison,
    currentGeneratedAt: '2026-08-03T02:05:00.000Z'
  };
  delete distinctComparison.comparisonId;
  const distinctArtifact = core.tryPersistPendingChange(
    distinctComparison,
    storage,
    repeatedArtifact.envelope
  );
  assert.equal(distinctArtifact.envelope.comparisons.length, 2);
});

test('pending write failure blocks baseline advancement and notification eligibility', () => {
  const previous = completeSnapshot(100, [1, 2]);
  const current = completeSnapshot(100, [1, 3]);
  const comparison = core.compareCompleteSnapshots(previous, current);
  const writes = [];
  const storage = {
    getItem() {
      return null;
    },
    setItem(key) {
      writes.push(key);
      throw new Error('pending quota fixture');
    }
  };
  const result = core.persistDetectedChangeBeforeBaseline(
    comparison,
    current,
    storage
  );

  assert.equal(result.pending.saved, false);
  assert.equal(result.baseline.attempted, false);
  assert.equal(result.noticeEligible, false);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /PendingComparison:100:cmp-v1-/);
});

test('baseline write failure leaves persisted pending artifact recoverable', () => {
  const previous = completeSnapshot(100, [1, 2]);
  const current = completeSnapshot(100, [1, 3]);
  const comparison = core.compareCompleteSnapshots(previous, current);
  const storage = memoryStorage();
  const originalSetItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (/LastComplete:100$/.test(key)) throw new Error('baseline quota fixture');
    originalSetItem(key, value);
  };
  const result = core.persistDetectedChangeBeforeBaseline(
    comparison,
    current,
    storage
  );

  assert.equal(result.pending.saved, true);
  assert.equal(result.baseline.saved, false);
  assert.equal(result.noticeEligible, false);
  assert.ok(core.readPendingChange(100, storage).envelope);
});

test('two concurrent pending writers merge by stable comparison ID', () => {
  const previous = completeSnapshot(100, [1, 2, 3], {
    generatedAt: '2026-08-03T01:00:00.000Z'
  });
  const currentA = completeSnapshot(100, [1, 3, 4], {
    generatedAt: '2026-08-03T02:00:00.000Z'
  });
  const currentB = completeSnapshot(100, [1, 2, 5], {
    generatedAt: '2026-08-03T02:01:00.000Z'
  });
  const comparisonA = core.compareCompleteSnapshots(previous, currentA);
  const comparisonB = core.compareCompleteSnapshots(previous, currentB);
  assert.notEqual(comparisonA.comparisonId, comparisonB.comparisonId);

  const storage = memoryStorage();
  const originalSetItem = storage.setItem.bind(storage);
  let injectedWriter = false;
  let sabotageFirstAggregateFromA = false;
  storage.setItem = (key, value) => {
    if (
      !injectedWriter &&
      key.endsWith(comparisonA.comparisonId)
    ) {
      injectedWriter = true;
      const writerB = core.tryPersistPendingChange(comparisonB, storage);
      assert.equal(writerB.saved, true);
      sabotageFirstAggregateFromA = true;
    }
    if (sabotageFirstAggregateFromA && /PendingChange:100$/.test(key)) {
      sabotageFirstAggregateFromA = false;
      const staleEnvelope = JSON.parse(value);
      staleEnvelope.comparisons = staleEnvelope.comparisons.filter(
        item => item.comparisonId !== comparisonA.comparisonId
      );
      staleEnvelope.lastDetectedComparison = staleEnvelope.comparisons.at(-1);
      originalSetItem(key, JSON.stringify(staleEnvelope));
      return;
    }
    originalSetItem(key, value);
  };

  const writerA = core.tryPersistPendingChange(comparisonA, storage);
  assert.equal(writerA.saved, true);
  assert.equal(writerA.attempts, 2, 'optimistic verification must retry a stale aggregate');
  const merged = core.readPendingChange(100, storage).envelope;
  assert.deepEqual(
    Array.from(merged.comparisons, item => item.comparisonId).sort(),
    [comparisonA.comparisonId, comparisonB.comparisonId].sort()
  );
});

test('an older completed scan cannot roll lastComplete backward', () => {
  const storage = memoryStorage();
  const newer = completeSnapshot(100, [1, 2], {
    generatedAt: '2026-08-03T03:00:00.000Z'
  });
  const older = completeSnapshot(100, [1, 2], {
    generatedAt: '2026-08-03T02:00:00.000Z'
  });

  assert.equal(core.tryPersistLatestComplete(newer, storage).saved, true);
  const stale = core.tryPersistLatestComplete(older, storage);
  assert.equal(stale.saved, false);
  assert.equal(stale.staleRejected, true);
  assert.match(stale.error, /拒绝回退基线/);
  assert.equal(core.readLastComplete(100, storage).report.generatedAt, newer.generatedAt);
});

test('notification de-duplication occurs after comparison artifact assignment', () => {
  const artifactIndex = source.indexOf('state.comparison = comparison;', source.indexOf('if (automatic && complete'));
  const noticeIndex = source.indexOf('markNoticeOnce(login.uid, fingerprint, storage)', artifactIndex);
  const pendingIndex = source.indexOf('persistDetectedChangeBeforeBaseline(', artifactIndex);
  assert.ok(artifactIndex > 0);
  assert.ok(pendingIndex > artifactIndex);
  assert.ok(noticeIndex > pendingIndex);
});

test('file input is captured once before await and always cleared in finally', () => {
  assert.match(
    source,
    /q\('\.import'\)\.onchange = async event => \{\n    const input = event\.currentTarget;\n    const file = input\?\.files\?\.\[0\];/
  );
  assert.match(source, /finally \{\n      if \(input\) input\.value = '';\n    \}/);
  assert.doesNotMatch(source, /event\.target\.value\s*=/);
});

test('Tampermonkey isolated storage adapter shares keys independently of page origin', () => {
  const values = new Map();
  const scope = {
    GM_getValue(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    GM_setValue(key, value) { values.set(key, value); },
    GM_deleteValue(key) { values.delete(key); },
    GM_listValues() { return [...values.keys()]; }
  };
  const storage = core.createPersistentStorageAdapter(scope);
  assert.equal(storage.storageKind, 'tampermonkey-isolated');
  storage.setItem('b', '2');
  storage.setItem('a', '1');
  assert.equal(storage.length, 2);
  assert.equal(storage.key(0), 'a');
  assert.equal(storage.getItem('b'), '2');
  storage.removeItem('b');
  assert.equal(storage.getItem('b'), null);
  assert.equal(storage.length, 1);
});

test('monitor metadata and BFCache recovery are wired for shared persistent state', () => {
  assert.match(source, /\/\/ @grant\s+GM_getValue/);
  assert.match(source, /\/\/ @grant\s+GM_listValues/);
  assert.match(source, /window\.addEventListener\('pagehide', clearMonitorTimer\);/);
  assert.match(
    source,
    /window\.addEventListener\('pageshow', event => \{[\s\S]*event\.persisted[\s\S]*armMonitor\(\);/
  );
});
