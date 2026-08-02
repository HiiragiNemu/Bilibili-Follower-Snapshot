import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const probe = require('../research/bilibili_follower_endpoint_probe.js');

function makeRaw(url, data, overrides = {}) {
  return {
    ok: true,
    url,
    params: [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value })),
    httpStatus: 200,
    code: 0,
    durationMs: 1,
    errorClass: null,
    message: '',
    dataKeys: data && typeof data === 'object' ? Object.keys(data) : [],
    data,
    ...overrides
  };
}

function uidList(start, count) {
  return Array.from({ length: count }, (_, index) => ({ mid: start + index }));
}

test('a repeated rcmd sentinel does not stop the advancing official cursor chain', async () => {
  const calls = [];
  const pages = [
    { list: uidList(1, 50), offset: 'rcmd', re_version: 7, total: 948 },
    { list: uidList(51, 50), offset: 'rcmd', re_version: 8, total: 948 },
    { list: [], offset: 'rcmd', re_version: 9, total: 948 },
    { list: [], offset: 'rcmd', re_version: 10, total: 948 }
  ];
  const request = async url => {
    calls.push(new URL(url));
    return makeRaw(url, pages[calls.length - 1]);
  };

  const result = await probe.probeCursorChain({
    uid: 123456,
    pageSize: 50,
    lastAccessTs: 1777777777,
    maxSteps: 10,
    emptyPageLimit: 2,
    noProgressPageLimit: 2,
    request,
    delayMs: 0
  });

  assert.deepEqual(calls.map(url => url.searchParams.get('pn')), ['1', '2', '3', '4']);
  assert.deepEqual(calls.map(url => url.searchParams.get('offset')), ['', 'rcmd', 'rcmd', 'rcmd']);
  assert.deepEqual(calls.map(url => url.searchParams.get('re_version')), ['0', '7', '8', '9']);
  assert.ok(calls.every(url => url.searchParams.get('last_access_ts') === '1777777777'));
  assert.ok(calls.every(url => url.searchParams.get('from') === 'main'));
  assert.ok(calls.every(url => url.searchParams.get('gaia_source') === 'main_web'));
  assert.equal(result.report.uniqueUidCount, 100);
  assert.equal(result.report.pages[1].responseOffsetRepeated, true);
  assert.equal(result.report.stopReason, 'consecutive-empty-pages:2');
  assert.doesNotMatch(result.report.stopReason, /offset/i);
});

test('a reported total of 1050 can produce only 1000 identities on ordinary pages', async () => {
  const calls = [];
  const request = async url => {
    const parsed = new URL(url);
    const pn = Number(parsed.searchParams.get('pn'));
    calls.push(pn);
    const list = pn <= 20 ? uidList((pn - 1) * 50 + 1, 50) : [];
    return makeRaw(url, { list, total: 1050 });
  };

  const result = await probe.probeNumberedCollection({
    endpoint: 'fans',
    uid: 123456,
    total: 1050,
    pageSize: 50,
    boundaryThroughPage: 22,
    request,
    delayMs: 0
  });

  assert.deepEqual(calls, Array.from({ length: 22 }, (_, index) => index + 1));
  assert.equal(result.report.sequentialReturnedCount, 1000);
  assert.equal(result.report.sequentialUniqueUidCount, 1000);
  assert.equal(result.report.reportedTotal, 1050);
  assert.equal(result.report.coverageStatus, 'incomplete');
  assert.equal(result.report.detailLimitObserved, true);
  assert.equal(result.report.pages.find(page => page.pn === 21).listLength, 0);
});

test('detail-limit evidence requires 1000 unique UIDs and totals on every sequential page', async () => {
  const duplicateResult = await probe.probeNumberedCollection({
    endpoint: 'fans',
    uid: 123456,
    total: 1050,
    pageSize: 50,
    boundaryThroughPage: 22,
    delayMs: 0,
    async request(url) {
      const pn = Number(new URL(url).searchParams.get('pn'));
      return makeRaw(url, {
        list: pn <= 20 ? uidList(1, 50) : [],
        total: 1050
      });
    }
  });

  assert.equal(duplicateResult.report.sequentialReturnedCount, 1000);
  assert.equal(duplicateResult.report.sequentialUniqueUidCount, 50);
  assert.equal(duplicateResult.report.detailLimitObserved, false);

  const missingTotalResult = await probe.probeNumberedCollection({
    endpoint: 'fans',
    uid: 123456,
    total: 1050,
    pageSize: 50,
    boundaryThroughPage: 22,
    delayMs: 0,
    async request(url) {
      const pn = Number(new URL(url).searchParams.get('pn'));
      const data = {
        list: pn <= 20 ? uidList((pn - 1) * 50 + 1, 50) : [],
        total: 1050
      };
      if (pn === 10) delete data.total;
      return makeRaw(url, data);
    }
  });

  assert.equal(missingTotalResult.report.sequentialUniqueUidCount, 1000);
  assert.equal(missingTotalResult.report.sequentialTotalsPresentOnEveryPage, false);
  assert.equal(missingTotalResult.report.detailLimitObserved, false);
});

test('a decisive sequential failure stops the route and records every unprobed page', async () => {
  const calls = [];
  const result = await probe.probeNumberedCollection({
    endpoint: 'followers',
    uid: 123456,
    total: 1000,
    pageSize: 50,
    boundaryThroughPage: 22,
    consecutiveFailureLimit: 2,
    delayMs: 0,
    async request(url) {
      const pn = Number(new URL(url).searchParams.get('pn'));
      calls.push(pn);
      if (pn === 2) {
        return makeRaw(url, null, {
          ok: false,
          errorClass: 'timeout',
          message: 'fixture timeout'
        });
      }
      return makeRaw(url, { list: uidList(1, 50), total: 1000 });
    }
  });

  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.report.stopReason, 'sequential-request-failed:pn-2:timeout');
  assert.equal(result.report.stoppedEarly, true);
  assert.deepEqual(result.report.unprobedPages, Array.from({ length: 20 }, (_, index) => index + 3));
  assert.equal(result.report.unprobedSequentialPageCount, 19);
  assert.deepEqual(result.report.unprobedBoundaryPages, [22]);
  assert.equal(result.report.coverageStatus, 'inconclusive');
});

test('numbered coverage rejects over-coverage and page totals that disagree with stat', async () => {
  const request = async url => {
    const pn = Number(new URL(url).searchParams.get('pn'));
    return makeRaw(url, {
      list: pn === 1 ? uidList(1, 4) : [],
      total: 4
    });
  };

  const result = await probe.probeNumberedCollection({
    endpoint: 'fans',
    uid: 123456,
    total: 3,
    pageSize: 50,
    boundaryThroughPage: 22,
    request,
    delayMs: 0
  });

  assert.equal(result.report.sequentialUniqueUidCount, 4);
  assert.equal(result.report.overCoverage, true);
  assert.deepEqual(result.report.sequentialReportedTotals, [4]);
  assert.equal(result.report.sequentialTotalsAgreeWithStat, false);
  assert.equal(result.report.coverageStatus, 'inconclusive');
});

test('numbered coverage stays inconclusive when any sequential page omits data.total', async () => {
  const request = async url => {
    const pn = Number(new URL(url).searchParams.get('pn'));
    const data = {
      list: pn === 1 ? uidList(1, 2) : pn === 2 ? uidList(3, 1) : [],
      total: 3
    };
    if (pn === 2) delete data.total;
    return makeRaw(url, data);
  };

  const result = await probe.probeNumberedCollection({
    endpoint: 'followers',
    uid: 123456,
    total: 3,
    pageSize: 2,
    boundaryThroughPage: 3,
    request,
    delayMs: 0
  });

  assert.equal(result.report.sequentialUniqueUidCount, 3);
  assert.equal(result.report.exactCoverage, true);
  assert.equal(result.report.sequentialTotalsPresentOnEveryPage, false);
  assert.equal(result.report.sequentialTotalsAgreeWithStat, false);
  assert.equal(result.report.coverageStatus, 'inconclusive');
});

test('a failed optional boundary sample does not invalidate complete sequential coverage', async () => {
  const calls = [];
  const request = async url => {
    const pn = Number(new URL(url).searchParams.get('pn'));
    calls.push(pn);
    if (pn >= 20) {
      return makeRaw(url, null, {
        ok: false,
        httpStatus: 412,
        code: -400,
        errorClass: 'business',
        message: 'boundary fixture failed'
      });
    }
    const list = pn === 1 ? uidList(1, 2) : pn === 2 ? uidList(3, 1) : [];
    return makeRaw(url, { list, total: 3 });
  };

  const result = await probe.probeNumberedCollection({
    endpoint: 'followers',
    uid: 123456,
    total: 3,
    pageSize: 2,
    boundaryThroughPage: 3,
    request,
    delayMs: 0
  });

  assert.equal(result.report.coverageStatus, 'complete');
  assert.equal(result.report.sequentialFailedPageCount, 0);
  assert.deepEqual(calls, [1, 2, 3, 20, 21]);
  assert.equal(result.report.boundaryFailedPageCount, 2);
  assert.equal(result.report.stopReason, 'consecutive-request-failures:2');
  assert.deepEqual(result.report.unprobedBoundaryPages, [22]);
  assert.equal(result.report.unprobedBoundaryPageCount, 1);
  assert.equal(result.report.boundaryStatus, 'inconclusive');
});

test('reported last-page sampling is opt-in for very large totals', () => {
  const normal = probe.planNumberedPages(5000, 50, 22, false);
  const withFarBoundary = probe.planNumberedPages(5000, 50, 22, true);
  assert.equal(normal.all.includes(100), false);
  assert.equal(withFarBoundary.all.includes(100), true);
  assert.equal(withFarBoundary.all.includes(101), true);
});

test('request and stat failures remain inconclusive instead of becoming negative evidence', async () => {
  const errorClasses = ['cors-or-network', 'http', 'json', 'business', 'http', 'json'];
  let callIndex = 0;
  const request = async url => {
    const errorClass = errorClasses[callIndex++];
    return makeRaw(url, null, {
      ok: false,
      httpStatus: errorClass === 'http' ? 503 : 200,
      code: errorClass === 'business' ? -101 : null,
      errorClass,
      message: `fixture-${errorClass}`,
      dataKeys: []
    });
  };

  const creator = await probe.runCreatorCenter({ uid: 123456, request, delayMs: 0 });
  assert.equal(creator.status, 'inconclusive');
  assert.equal(creator.failedEndpointCount, 6);
  assert.match(creator.conclusion, /不据此判断/);
  assert.doesNotMatch(creator.conclusion, /不存在/);
  assert.ok(creator.endpoints.every(endpoint => endpoint.status === 'inconclusive'));

  assert.deepEqual(
    probe.parseRelationStat({ ok: false, errorClass: 'cors-or-network', data: null }),
    { status: 'inconclusive', total: null, reason: 'cors-or-network' }
  );
  assert.deepEqual(
    probe.parseRelationStat({ ok: true, data: {} }),
    { status: 'inconclusive', total: null, reason: 'missing-or-invalid-follower-total' }
  );
});

test('creator fan rank_list descendants are not treated as follower identity evidence', async () => {
  const request = async url => {
    const parsed = new URL(url);
    const data = parsed.pathname.endsWith('/fan')
      ? {
          rank_list: {
            dynamic_act: [{ mid: 11, uname: '互动账号', relation: 1 }],
            video_act: [{ mid: 12, uname: '互动账号', relation: 1 }],
            video_play: [{ mid: 13, uname: '互动账号', relation: 1 }]
          }
        }
      : {};
    return makeRaw(url, data);
  };

  const creator = await probe.runCreatorCenter({ uid: 123456, request, delayMs: 0 });
  const fan = creator.endpoints.find(endpoint => endpoint.id === 'fan');
  const rankedArrays = fan.arrays.filter(array => array.path.startsWith('data.rank_list.'));

  assert.equal(creator.status, 'no-evidence');
  assert.equal(creator.identityCandidateArrayCount, 0);
  assert.equal(rankedArrays.length, 3);
  assert.ok(rankedArrays.every(
    array => array.classification === 'content-ranking-not-follower-identity'
  ));
  assert.equal(fan.url, 'https://member.bilibili.com/x/web/data/fan?tmid=123456');
  assert.equal(new URL(fan.url).searchParams.has('month'), false);
});

test('strong identity arrays outside fan rank_list remain candidates', async () => {
  const request = async url => {
    const parsed = new URL(url);
    const data = parsed.pathname.endsWith('/action')
      ? { hypothetical_identity_array: [{ mid: 21, uname: '候选账号' }] }
      : {};
    return makeRaw(url, data);
  };

  const creator = await probe.runCreatorCenter({ uid: 123456, request, delayMs: 0 });
  assert.equal(creator.status, 'candidate-found');
  assert.equal(creator.identityCandidateArrayCount, 1);
});

test('creator array discovery covers item eleven and nesting deeper than seven levels', async () => {
  function deeplyNestedIdentity(uid) {
    let value = [{ mid: uid, uname: `candidate-${uid}` }];
    for (let level = 0; level < 9; level += 1) value = { next: value };
    return value;
  }

  const request = async url => {
    const parsed = new URL(url);
    let data = {};
    if (parsed.pathname.endsWith('/action')) {
      data = {
        containers: [
          ...Array.from({ length: 10 }, (_, index) => ({ note: `filler-${index}` })),
          deeplyNestedIdentity(71)
        ]
      };
    } else if (parsed.pathname.endsWith('/fan')) {
      data = {
        rank_list: {
          containers: [
            ...Array.from({ length: 10 }, (_, index) => ({ note: `rank-${index}` })),
            deeplyNestedIdentity(72)
          ]
        }
      };
    }
    return makeRaw(url, data);
  };

  const creator = await probe.runCreatorCenter({ uid: 123456, request, delayMs: 0 });
  const action = creator.endpoints.find(endpoint => endpoint.id === 'action');
  const fan = creator.endpoints.find(endpoint => endpoint.id === 'fan');
  const deepAction = action.arrays.find(array => array.uniqueUidCount === 1);
  const deepFan = fan.arrays.find(array => array.uniqueUidCount === 1);

  assert.equal(deepAction.classification, 'identity-candidate-needs-validation');
  assert.equal(deepFan.classification, 'content-ranking-not-follower-identity');
  assert.match(deepAction.path, /\[10\](?:\.next){9}$/);
  assert.match(deepFan.path, /rank_list.*\[10\](?:\.next){9}$/);
});

test('UID set SHA-256 is deterministic and independent of insertion order', async () => {
  const left = await probe.sha256UidSet(new Set([3, 1, 2]));
  const right = await probe.sha256UidSet(new Set([2, 3, 1]));
  assert.equal(left.status, 'computed');
  assert.equal(left.algorithm, 'SHA-256');
  assert.match(left.value, /^[0-9a-f]{64}$/);
  assert.equal(left.value, right.value);
});

test('default share report redacts account and endpoint identity fields', () => {
  const shared = probe.makeShareReport({
    account: { uid: 987654, name: 'private fixture name' },
    requests: [{
      url: 'https://api.bilibili.com/x/relation/fans?vmid=987654&pn=1',
      params: [{ name: 'vmid', value: '987654' }, { name: 'pn', value: '1' }],
      message: 'fixture echoed vmid=987654 for private fixture name; uid 987654'
    }],
    tests: {
      page: { firstUid: 222, lastUid: 333 },
      nested: { fatalError: 'private fixture name (987654)' }
    }
  });
  const text = JSON.stringify(shared);
  assert.equal(shared.shareReport, true);
  assert.deepEqual(shared.account, { uid: 'SELF_UID', name: 'ACCOUNT_NAME' });
  assert.equal(text.includes('987654'), false);
  assert.equal(text.includes('private fixture name'), false);
  assert.equal(text.includes('222'), false);
  assert.equal(text.includes('333'), false);
  assert.match(shared.requests[0].message, /vmid=SELF_UID/);
  assert.equal(text.includes('private fixture name'), false);
  assert.match(shared.requests[0].url, /vmid=SELF_UID/);
});

test('requester classifies timeout and external cancellation separately', async () => {
  const hangingFetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted fixture');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const timed = probe.createRequester({ fetchImpl: hangingFetch, timeoutMs: 5 });
  const timedResult = await timed.get('https://api.example.test/timeout', 'timeout');
  assert.equal(timedResult.errorClass, 'timeout');

  const controller = new AbortController();
  controller.abort();
  const cancelled = probe.createRequester({
    fetchImpl: hangingFetch,
    timeoutMs: 1000,
    signal: controller.signal
  });
  await assert.rejects(
    cancelled.get('https://api.example.test/cancel', 'cancel'),
    error => error?.name === 'AbortError'
  );
  assert.equal(cancelled.requests[0].errorClass, 'cancelled');
});

test('requester distinguishes CORS/network, HTTP, JSON and business failures', async () => {
  const fixtures = [
    {
      expected: 'cors-or-network',
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      }
    },
    {
      expected: 'http',
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        async text() { return '{"code":0,"data":null}'; }
      })
    },
    {
      expected: 'json',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() { return '<html>not json</html>'; }
      })
    },
    {
      expected: 'business',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() { return '{"code":-101,"message":"not logged in","data":null}'; }
      })
    }
  ];

  for (const fixture of fixtures) {
    const requester = probe.createRequester({
      fetchImpl: fixture.fetchImpl,
      timeoutMs: 100
    });
    const result = await requester.get('https://api.example.test/failure', fixture.expected);
    assert.equal(result.errorClass, fixture.expected);
  }
});

test('browser launcher remains idle until its manual start button is used', async () => {
  const elementsById = new Map();
  function element(tagName) {
    return {
      tagName,
      id: '',
      style: {},
      textContent: '',
      disabled: false,
      children: [],
      listeners: new Map(),
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      addEventListener(name, listener) { this.listeners.set(name, listener); }
    };
  }
  const body = element('body');
  body.appendChild = child => {
    body.children.push(child);
    if (child.id) elementsById.set(child.id, child);
  };
  const environment = {
    document: {
      body,
      createElement: element,
      getElementById: id => elementsById.get(id) ?? null
    }
  };
  environment[probe.RUN_GUARD] = {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    error: null,
    controller: null
  };
  let runs = 0;
  const api = {
    ...probe,
    async runAndPublish(options) {
      runs += 1;
      options.onRequest({}, 1);
      return { runStatus: 'completed', requests: [{}], tests: {} };
    }
  };

  const panel = probe.mountLauncher(api, environment);
  assert.equal(runs, 0);
  const start = panel.children.find(child => child.textContent === '开始只读探测');
  assert.ok(start);
  await start.listeners.get('click')();
  assert.equal(runs, 1);
  assert.equal(environment[probe.RUN_GUARD].status, 'completed');
});
