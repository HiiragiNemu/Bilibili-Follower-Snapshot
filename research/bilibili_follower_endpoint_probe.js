// Bilibili 粉丝接口只读探测器 v2。仅执行 GET，不输出登录凭据。
(function initialiseFollowerEndpointProbe(globalObject) {
  'use strict';

  function createProbeApi() {
    const REPORT_TYPE = 'bilibili-follower-endpoint-probe';
    const REPORT_VERSION = 2;
    const RUN_GUARD = '__BILI_FOLLOWER_ENDPOINT_PROBE_RUN_STATE__';
    const API_GLOBAL = '__BILI_FOLLOWER_ENDPOINT_PROBE_API__';
    const REPORT_GLOBAL = '__BILI_FOLLOWER_ENDPOINT_PROBE__';
    const SENSITIVE_PARAMETER = /^(?:access_key|access_token|bili_jct|cookie|csrf|csrf_token|password|refresh_token|sessdata|token)$/i;
    const DEFAULT_CONFIG = Object.freeze({
      pageSize: 50,
      requestDelayMs: 350,
      boundaryThroughPage: 22,
      numberedConsecutiveFailureLimit: 2,
      cursorMaxSteps: 30,
      cursorEmptyPageLimit: 2,
      cursorNoProgressPageLimit: 2,
      includeReportedLastPageBoundary: false,
      requestTimeoutMs: 20000
    });

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function finiteNumber(value) {
      if (value == null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function positiveUid(item) {
      const uid = Number(item?.mid ?? item?.uid);
      return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
    }

    function objectKeys(value) {
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value)
        : [];
    }

    function safeErrorMessage(error) {
      const message = String(error?.message ?? error ?? '未知错误');
      return message.replace(/(SESSDATA|bili_jct|access_key|access_token|cookie|csrf|csrf_token|password|refresh_token|token)=[^\s&]+/gi, '$1=[已隐藏]');
    }

    function sanitiseUrl(input) {
      const url = new URL(String(input));
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_PARAMETER.test(key)) url.searchParams.delete(key);
      }
      return url.toString();
    }

    function literalParameters(input) {
      const url = new URL(String(input));
      return [...url.searchParams.entries()].map(([name, value]) => ({ name, value }));
    }

    function classifyThrownError(error) {
      if (error?.name === 'AbortError') return 'timeout';
      // Browsers deliberately do not distinguish a CORS rejection from many network failures.
      if (error instanceof TypeError || error?.name === 'TypeError') return 'cors-or-network';
      return 'network';
    }

    function createRequester(options = {}) {
      const fetchImpl = options.fetchImpl;
      const timeoutMs = finiteNumber(options.timeoutMs) ?? DEFAULT_CONFIG.requestTimeoutMs;
      const clock = options.clock ?? (() => Date.now());
      const externalSignal = options.signal ?? null;
      const onRequest = typeof options.onRequest === 'function' ? options.onRequest : () => {};
      const requests = [];

      if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数');

      async function get(input, label = '') {
        const url = sanitiseUrl(input);
        const record = {
          label,
          method: 'GET',
          url,
          params: literalParameters(url),
          httpStatus: null,
          code: null,
          durationMs: null,
          errorClass: null,
          message: '',
          dataKeys: []
        };
        const startedAt = clock();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timedOut = false;
        let cancelled = externalSignal?.aborted === true;
        const onExternalAbort = () => {
          cancelled = true;
          controller?.abort();
        };
        if (externalSignal && !cancelled) {
          externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
        const timer = controller && timeoutMs > 0 && !cancelled
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs)
          : null;
        let data = null;

        try {
          if (cancelled) {
            const error = new Error('探测已由用户取消');
            error.name = 'AbortError';
            throw error;
          }
          const response = await fetchImpl(url, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'application/json, text/plain, */*' },
            ...(controller ? { signal: controller.signal } : {})
          });
          record.httpStatus = finiteNumber(response?.status);

          let json = null;
          let parseError = null;
          try {
            if (typeof response?.text === 'function') {
              const text = await response.text();
              json = text === '' ? null : JSON.parse(text);
            } else if (typeof response?.json === 'function') {
              json = await response.json();
            } else {
              throw new TypeError('响应不支持 JSON 读取');
            }
          } catch (error) {
            parseError = error;
          }

          if (json && typeof json === 'object') {
            record.code = json.code ?? null;
            record.message = String(json.message ?? json.msg ?? '');
            data = json.data ?? null;
            record.dataKeys = objectKeys(data);
          }

          if (!response?.ok) {
            record.errorClass = 'http';
            if (!record.message) record.message = `HTTP ${record.httpStatus ?? '未知'}`;
          } else if (parseError) {
            record.errorClass = 'json';
            record.message = safeErrorMessage(parseError);
          } else if (!json || typeof json !== 'object') {
            record.errorClass = 'json';
            record.message = '响应不是 JSON 对象';
          } else if (record.code !== 0) {
            record.errorClass = 'business';
          }
        } catch (error) {
          record.errorClass = cancelled
            ? 'cancelled'
            : timedOut
              ? 'timeout'
              : classifyThrownError(error);
          record.message = safeErrorMessage(error);
        } finally {
          if (timer) clearTimeout(timer);
          externalSignal?.removeEventListener?.('abort', onExternalAbort);
          record.durationMs = Math.max(0, Math.round(clock() - startedAt));
          const savedRecord = { ...record, params: record.params.map(item => ({ ...item })) };
          requests.push(savedRecord);
          try {
            onRequest({ ...savedRecord, params: savedRecord.params.map(item => ({ ...item })) }, requests.length);
          } catch {
            // A progress renderer must never change probe semantics.
          }
        }

        if (record.errorClass === 'cancelled') {
          const error = new Error('探测已由用户取消');
          error.name = 'AbortError';
          throw error;
        }
        return { ...record, ok: record.errorClass == null, data };
      }

      return { get, requests };
    }

    function requestSummary(raw) {
      return {
        ok: raw?.ok === true,
        url: raw?.url ?? '',
        params: Array.isArray(raw?.params) ? raw.params.map(item => ({ ...item })) : [],
        httpStatus: raw?.httpStatus ?? null,
        code: raw?.code ?? null,
        durationMs: raw?.durationMs ?? null,
        errorClass: raw?.errorClass ?? null,
        message: raw?.message ?? '',
        dataKeys: Array.isArray(raw?.dataKeys) ? [...raw.dataKeys] : objectKeys(raw?.data)
      };
    }

    function listFrom(raw) {
      return Array.isArray(raw?.data?.list) ? raw.data.list : [];
    }

    function listSummary(raw) {
      const list = listFrom(raw);
      return {
        ...requestSummary(raw),
        total: finiteNumber(raw?.data?.total),
        listLength: list.length,
        offset: raw?.data?.offset ?? null,
        reVersion: raw?.data?.re_version ?? null,
        firstUid: positiveUid(list[0]),
        lastUid: positiveUid(list[list.length - 1]),
        containsMtime: list.some(item => item?.mtime != null),
        containsRecommendationFields: list.some(item => item?.rec_reason != null || item?.track_id != null)
      };
    }

    function summariseArray(value) {
      const array = Array.isArray(value) ? value : [];
      const objects = array.filter(item => item && typeof item === 'object' && !Array.isArray(item));
      const sampleKeys = [...new Set(objects.slice(0, 10).flatMap(item => Object.keys(item)))].sort();
      const allKeys = new Set(objects.flatMap(item => Object.keys(item)));
      const uidSet = new Set(objects.map(positiveUid).filter(Boolean));
      return {
        length: array.length,
        objectCount: objects.length,
        sampleKeys,
        uniqueUidCount: uidSet.size,
        containsStrongIdentityKey: allKeys.has('mid') || allKeys.has('uid'),
        containsNameLikeKey: ['name', 'uname', 'face'].some(key => allKeys.has(key)),
        containsMtime: allKeys.has('mtime')
      };
    }

    function arrayClassification(path, sourceId, summary) {
      // The current `fan` response nests several identity-shaped interaction
      // rankings below data.rank_list (for example dynamic_act and video_act).
      // Their mid/uname fields identify ranked interactors, not a complete
      // follower roster, so the semantic exclusion must cover every descendant.
      if (sourceId === 'fan' && /(?:^|\.)rank_list(?:\.|\[|$)/.test(path)) {
        return 'content-ranking-not-follower-identity';
      }
      if (summary.containsStrongIdentityKey) return 'identity-candidate-needs-validation';
      if (summary.containsNameLikeKey) return 'name-like-only-not-identity-evidence';
      return 'not-identity-shaped';
    }

    function collectArraySummaries(value, options = {}, path = 'data', depth = 0, seen = new Set()) {
      if (value == null || typeof value !== 'object' || seen.has(value)) return [];
      seen.add(value);
      const results = [];
      if (Array.isArray(value)) {
        const summary = summariseArray(value);
        results.push({
          path,
          ...summary,
          classification: arrayClassification(path, options.sourceId ?? '', summary)
        });
        for (let index = 0; index < value.length; index += 1) {
          results.push(...collectArraySummaries(value[index], options, `${path}[${index}]`, depth + 1, seen));
        }
      } else {
        for (const [key, nested] of Object.entries(value)) {
          results.push(...collectArraySummaries(nested, options, `${path}.${key}`, depth + 1, seen));
        }
      }
      return results;
    }

    function parseRelationStat(raw) {
      if (!raw?.ok) {
        return { status: 'inconclusive', total: null, reason: raw?.errorClass ?? 'request-failed' };
      }
      const total = finiteNumber(raw?.data?.follower);
      if (total == null || total < 0) {
        return { status: 'inconclusive', total: null, reason: 'missing-or-invalid-follower-total' };
      }
      return { status: 'observed', total, reason: '' };
    }

    function range(start, end) {
      const values = [];
      for (let value = start; value <= end; value += 1) values.push(value);
      return values;
    }

    function planNumberedPages(total, pageSize, boundaryThroughPage, includeReportedLastPageBoundary = false) {
      const reportedLastPage = total == null ? null : Math.max(1, Math.ceil(total / pageSize));
      const sequentialEnd = reportedLastPage == null
        ? boundaryThroughPage
        : Math.min(boundaryThroughPage, reportedLastPage + 1);
      const sequential = range(1, Math.max(1, sequentialEnd));
      const boundary = [1, 20, 21, 22];
      if (includeReportedLastPageBoundary && reportedLastPage != null) {
        boundary.push(reportedLastPage, reportedLastPage + 1);
      }
      const all = [...new Set([...sequential, ...boundary].filter(page => Number.isInteger(page) && page > 0))]
        .sort((left, right) => left - right);
      return { reportedLastPage, sequential, boundary: [...new Set(boundary)].sort((a, b) => a - b), all };
    }

    async function probeNumberedCollection(options) {
      const endpoint = options.endpoint;
      const uid = options.uid;
      const total = finiteNumber(options.total);
      const pageSize = finiteNumber(options.pageSize) ?? DEFAULT_CONFIG.pageSize;
      const boundaryThroughPage = finiteNumber(options.boundaryThroughPage) ?? DEFAULT_CONFIG.boundaryThroughPage;
      const consecutiveFailureLimit = Math.max(
        1,
        Math.floor(
          finiteNumber(options.consecutiveFailureLimit)
          ?? DEFAULT_CONFIG.numberedConsecutiveFailureLimit
        )
      );
      const delayMs = finiteNumber(options.delayMs) ?? 0;
      const sleepFn = options.sleepFn ?? sleep;
      const plan = planNumberedPages(
        total,
        pageSize,
        boundaryThroughPage,
        options.includeReportedLastPageBoundary === true
      );
      const sequentialPages = new Set(plan.sequential);
      const sequentialUidSet = new Set();
      const allSampledUidSet = new Set();
      const pages = [];
      let sequentialReturnedCount = 0;
      let consecutiveFailedPages = 0;
      let maxConsecutiveFailedPages = 0;
      let stopReason = 'planned-pages-completed';
      let unprobedPages = [];

      for (let index = 0; index < plan.all.length; index += 1) {
        const pn = plan.all[index];
        const inSequentialCollection = sequentialPages.has(pn);
        const params = new URLSearchParams({
          vmid: String(uid),
          pn: String(pn),
          ps: String(pageSize),
          order: 'desc'
        });
        const raw = await options.request(`https://api.bilibili.com/x/relation/${endpoint}?${params}`, `numbered-${endpoint}-pn-${pn}`);
        const list = listFrom(raw);
        const pageUidSet = new Set(list.map(positiveUid).filter(Boolean));
        for (const itemUid of pageUidSet) allSampledUidSet.add(itemUid);
        if (inSequentialCollection) {
          sequentialReturnedCount += list.length;
          for (const itemUid of pageUidSet) sequentialUidSet.add(itemUid);
        }
        pages.push({
          endpoint,
          pn,
          inSequentialCollection,
          uniqueUidOnPage: pageUidSet.size,
          ...listSummary(raw)
        });

        consecutiveFailedPages = raw?.ok ? 0 : consecutiveFailedPages + 1;
        maxConsecutiveFailedPages = Math.max(
          maxConsecutiveFailedPages,
          consecutiveFailedPages
        );
        const decisiveSequentialFailure = inSequentialCollection && !raw?.ok;
        const consecutiveFailureLimitReached =
          !raw?.ok && consecutiveFailedPages >= consecutiveFailureLimit;
        if (decisiveSequentialFailure || consecutiveFailureLimitReached) {
          stopReason = decisiveSequentialFailure
            ? `sequential-request-failed:pn-${pn}:${raw?.errorClass ?? 'unknown'}`
            : `consecutive-request-failures:${consecutiveFailureLimit}`;
          unprobedPages = plan.all.slice(index + 1);
          break;
        }
        if (delayMs > 0 && index < plan.all.length - 1) await sleepFn(delayMs);
      }

      const unprobedSequentialPages = unprobedPages.filter(page => sequentialPages.has(page));
      const unprobedBoundaryPages = unprobedPages.filter(page => !sequentialPages.has(page));
      const sequentialPagesResult = pages.filter(page => page.inSequentialCollection);
      const sequentialFailedPages = sequentialPagesResult.filter(page => !page.ok);
      const boundaryFailedPages = pages.filter(page => !page.inSequentialCollection && !page.ok);
      const sequentialReportedTotals = [...new Set(
        sequentialPagesResult
          .filter(page => page.ok && page.total != null && page.total >= 0)
          .map(page => page.total)
      )];
      const sequentialTotalsPresentOnEveryPage = sequentialPagesResult.length > 0
        && sequentialPagesResult.every(page => page.ok && page.total != null && page.total >= 0);
      const sequentialTotalsStable = sequentialReportedTotals.length <= 1;
      const sequentialTotalsAgreeWithStat = total != null
        && sequentialTotalsPresentOnEveryPage
        && sequentialReportedTotals.length === 1
        && sequentialReportedTotals[0] === total;
      const exactCoverage = total != null && sequentialUidSet.size === total;
      const overCoverage = total != null && sequentialUidSet.size > total;
      let coverageStatus = 'inconclusive';
      if (
        !sequentialFailedPages.length
        && total != null
        && sequentialTotalsStable
        && sequentialTotalsAgreeWithStat
      ) {
        coverageStatus = exactCoverage ? 'complete' : 'incomplete';
      }
      const afterLimitPages = pages.filter(page => page.pn >= 21 && page.inSequentialCollection);
      const detailLimitObserved = total != null
        && total > 1000
        && sequentialReturnedCount === 1000
        && sequentialUidSet.size === 1000
        && !sequentialFailedPages.length
        && unprobedSequentialPages.length === 0
        && sequentialTotalsPresentOnEveryPage
        && sequentialTotalsStable
        && sequentialTotalsAgreeWithStat
        && afterLimitPages.length > 0
        && afterLimitPages.every(
          page => page.ok && page.total === total && page.listLength === 0
        );

      return {
        report: {
          endpoint,
          pageSize,
          consecutiveFailureLimit,
          plan,
          pages,
          stopReason,
          stoppedEarly: unprobedPages.length > 0,
          unprobedPages,
          unprobedPageCount: unprobedPages.length,
          unprobedSequentialPages,
          unprobedSequentialPageCount: unprobedSequentialPages.length,
          unprobedBoundaryPages,
          unprobedBoundaryPageCount: unprobedBoundaryPages.length,
          maxConsecutiveFailedPages,
          sequentialReturnedCount,
          sequentialUniqueUidCount: sequentialUidSet.size,
          allSampledUniqueUidCount: allSampledUidSet.size,
          reportedTotal: total,
          coverageStatus,
          exactCoverage,
          overCoverage,
          sequentialReportedTotals,
          sequentialTotalsPresentOnEveryPage,
          sequentialTotalsStable,
          sequentialTotalsAgreeWithStat,
          detailLimitObserved,
          failedPageCount: sequentialFailedPages.length + boundaryFailedPages.length,
          sequentialFailedPageCount: sequentialFailedPages.length,
          boundaryFailedPageCount: boundaryFailedPages.length,
          boundaryStatus:
            boundaryFailedPages.length || unprobedBoundaryPages.length
              ? 'inconclusive'
              : 'observed'
        },
        uidSet: sequentialUidSet
      };
    }

    function cursorValue(value, fallback) {
      if (value == null) return fallback;
      return typeof value === 'string' ? value : JSON.stringify(value);
    }

    async function probeCursorChain(options) {
      const uid = options.uid;
      const total = finiteNumber(options.total);
      const pageSize = finiteNumber(options.pageSize) ?? DEFAULT_CONFIG.pageSize;
      const maxSteps = finiteNumber(options.maxSteps) ?? DEFAULT_CONFIG.cursorMaxSteps;
      const emptyPageLimit = finiteNumber(options.emptyPageLimit) ?? DEFAULT_CONFIG.cursorEmptyPageLimit;
      const noProgressPageLimit = finiteNumber(options.noProgressPageLimit) ?? DEFAULT_CONFIG.cursorNoProgressPageLimit;
      const lastAccessTs = finiteNumber(options.lastAccessTs) ?? 0;
      const delayMs = finiteNumber(options.delayMs) ?? 0;
      const sleepFn = options.sleepFn ?? sleep;
      const seen = new Set();
      const responseCursorOccurrences = new Map();
      const pages = [];
      let offset = '';
      let reVersion = '0';
      let consecutiveEmptyPages = 0;
      let consecutiveNoProgressPages = 0;
      let stopReason = '';
      let status = 'observed';

      for (let step = 1; step <= maxSteps; step += 1) {
        // These are the literal fields used by the current first-party follower-page chain.
        const params = new URLSearchParams({
          vmid: String(uid),
          pn: String(step),
          ps: String(pageSize),
          last_access_ts: String(lastAccessTs),
          from: 'main',
          re_version: String(reVersion),
          offset: String(offset),
          gaia_source: 'main_web'
        });
        const requestedOffset = offset;
        const requestedReVersion = reVersion;
        const raw = await options.request(`https://api.bilibili.com/x/relation/fans?${params}`, `cursor-fans-pn-${step}`);
        const list = listFrom(raw);
        let added = 0;
        for (const item of list) {
          const itemUid = positiveUid(item);
          if (itemUid && !seen.has(itemUid)) {
            seen.add(itemUid);
            added += 1;
          }
        }

        const responseOffset = cursorValue(raw?.data?.offset, '');
        const responseReVersion = cursorValue(raw?.data?.re_version, '0');
        const previousOccurrenceCount = responseCursorOccurrences.get(responseOffset) ?? 0;
        responseCursorOccurrences.set(responseOffset, previousOccurrenceCount + 1);
        const responseOffsetRepeated = responseOffset !== '' && previousOccurrenceCount > 0;

        consecutiveEmptyPages = list.length === 0 ? consecutiveEmptyPages + 1 : 0;
        consecutiveNoProgressPages = added === 0 ? consecutiveNoProgressPages + 1 : 0;
        pages.push({
          step,
          requestedPn: step,
          requestedOffset,
          requestedReVersion,
          responseOffset,
          responseReVersion,
          responseOffsetRepeated,
          added,
          cumulativeUniqueUidCount: seen.size,
          consecutiveEmptyPages,
          consecutiveNoProgressPages,
          ...listSummary(raw)
        });

        if (!raw?.ok) {
          stopReason = `request-failed:${raw?.errorClass ?? 'unknown'}`;
          status = 'inconclusive';
          break;
        }
        // A literal "rcmd" offset is a mode sentinel and may repeat while pn advances.
        // Repetition is therefore recorded but is deliberately not a stop condition.
        offset = responseOffset;
        reVersion = responseReVersion;
        if (consecutiveEmptyPages >= emptyPageLimit) {
          stopReason = `consecutive-empty-pages:${emptyPageLimit}`;
          break;
        }
        if (consecutiveNoProgressPages >= noProgressPageLimit) {
          stopReason = `consecutive-no-new-uids:${noProgressPageLimit}`;
          break;
        }
        if (step < maxSteps && delayMs > 0) await sleepFn(delayMs);
      }

      if (!stopReason) stopReason = `max-steps:${maxSteps}`;
      const exactCoverage = total != null && seen.size === total;
      const overCoverage = total != null && seen.size > total;
      const coverageStatus = status === 'inconclusive' || total == null || overCoverage
        ? 'inconclusive'
        : exactCoverage
          ? 'complete'
          : 'incomplete';
      return {
        report: {
          pageSize,
          reportedTotal: total,
          lastAccessTs,
          maxSteps,
          emptyPageLimit,
          noProgressPageLimit,
          pages,
          uniqueUidCount: seen.size,
          exactCoverage,
          overCoverage,
          coverageStatus,
          repeatedResponseOffsetCount: pages.filter(page => page.responseOffsetRepeated).length,
          stopReason,
          status
        },
        uidSet: seen
      };
    }

    async function probeUnread(options) {
      const delayMs = finiteNumber(options.delayMs) ?? 0;
      const sleepFn = options.sleepFn ?? sleep;
      const countRaw = await options.request(
        'https://api.bilibili.com/x/relation/followers/unread/count',
        'followers-unread-count'
      );
      if (delayMs > 0) await sleepFn(delayMs);
      const detailRaw = await options.request(
        'https://api.bilibili.com/x/relation/followers/Unread/detail',
        'followers-Unread-detail'
      );
      const arrayNames = ['prior_unread', 'normal_unread', 'has_read'];
      const arrays = Object.fromEntries(arrayNames.map(name => [name, summariseArray(detailRaw?.data?.[name])]));
      const status = countRaw?.ok && detailRaw?.ok ? 'observed' : 'inconclusive';
      const time = countRaw?.ok ? finiteNumber(countRaw?.data?.time) : null;

      return {
        status,
        count: {
          ...requestSummary(countRaw),
          count: countRaw?.ok ? finiteNumber(countRaw?.data?.count) : null,
          time
        },
        detail: {
          ...requestSummary(detailRaw),
          total: detailRaw?.ok ? finiteNumber(detailRaw?.data?.total) : null,
          newFansCount: detailRaw?.ok ? finiteNumber(detailRaw?.data?.new_fans_cnt) : null,
          arrays
        },
        cursorLastAccessTs: time ?? 0,
        cursorLastAccessTsSource: time == null ? 'fallback-zero' : 'unread-count.time'
      };
    }

    async function runCreatorCenter(options) {
      const uid = options.uid;
      const delayMs = finiteNumber(options.delayMs) ?? 0;
      const sleepFn = options.sleepFn ?? sleep;
      const endpoints = [
        { id: 'action', generation: 'current', url: `https://member.bilibili.com/x/web/data/action?tmid=${uid}` },
        { id: 'fan', generation: 'current', url: `https://member.bilibili.com/x/web/data/fan?tmid=${uid}` },
        { id: 'v2-num', generation: 'legacy-v2', url: 'https://member.bilibili.com/x/web/data/v2/fans/stat/num?period=2' },
        { id: 'v2-all-fans', generation: 'legacy-v2', url: 'https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type=all_fans&period=2' },
        { id: 'v2-follow', generation: 'legacy-v2', url: 'https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type=follow&period=2' },
        { id: 'v2-unfollow', generation: 'legacy-v2', url: 'https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type=unfollow&period=2' }
      ];
      const results = [];

      for (let index = 0; index < endpoints.length; index += 1) {
        const endpoint = endpoints[index];
        const raw = await options.request(endpoint.url, `creator-${endpoint.id}`);
        const arrays = collectArraySummaries(raw?.data, { sourceId: endpoint.id });
        const identityCandidateArrays = arrays.filter(array =>
          array.containsStrongIdentityKey
          && array.classification !== 'content-ranking-not-follower-identity'
        );
        results.push({
          id: endpoint.id,
          generation: endpoint.generation,
          status: raw?.ok ? 'observed' : 'inconclusive',
          ...requestSummary(raw),
          arrays,
          identityCandidateArrayCount: identityCandidateArrays.length,
          note: endpoint.id === 'fan'
            ? 'rank_list 是内容排行结构；仅有 name 等字段不构成粉丝身份证据。'
            : ''
        });
        if (delayMs > 0 && index < endpoints.length - 1) await sleepFn(delayMs);
      }

      const failures = results.filter(result => result.status === 'inconclusive');
      const identityCandidateArrayCount = results.reduce((sum, result) => sum + result.identityCandidateArrayCount, 0);
      const status = failures.length
        ? 'inconclusive'
        : identityCandidateArrayCount > 0
          ? 'candidate-found'
          : 'no-evidence';
      return {
        status,
        endpoints: results,
        failedEndpointCount: failures.length,
        identityCandidateArrayCount,
        conclusion: status === 'inconclusive'
          ? '至少一个创作中心请求因 CORS、HTTP、JSON、业务码或网络错误失败；本轮不据此判断身份列表存在与否。'
          : status === 'candidate-found'
            ? '发现含 mid/uid 的候选数组，仍需验证其语义是否确为粉丝身份。'
            : '本轮成功响应中没有发现含 mid/uid 的粉丝身份候选数组；这只是未发现证据，不等于接口不存在。'
      };
    }

    function overlapSummary(left, right) {
      let intersection = 0;
      for (const uid of left.uidSet) if (right.uidSet.has(uid)) intersection += 1;
      const union = left.uidSet.size + right.uidSet.size - intersection;
      return {
        left: left.id,
        right: right.id,
        status: left.status === 'inconclusive' || right.status === 'inconclusive' ? 'inconclusive' : 'observed',
        leftUniqueUidCount: left.uidSet.size,
        rightUniqueUidCount: right.uidSet.size,
        intersectionUidCount: intersection,
        onlyLeftUidCount: left.uidSet.size - intersection,
        onlyRightUidCount: right.uidSet.size - intersection,
        unionUidCount: union,
        jaccard: union ? Number((intersection / union).toFixed(6)) : null
      };
    }

    async function sha256UidSet(uidSet) {
      const canonical = [...uidSet]
        .map(value => Number(value))
        .filter(value => Number.isSafeInteger(value) && value > 0)
        .sort((left, right) => left - right)
        .join('\n');
      const subtle = globalObject?.crypto?.subtle;
      const Encoder = globalObject?.TextEncoder ?? (typeof TextEncoder === 'function' ? TextEncoder : null);
      if (!subtle || !Encoder) {
        return { status: 'unavailable', algorithm: 'SHA-256', value: null };
      }
      try {
        const digest = await subtle.digest('SHA-256', new Encoder().encode(canonical));
        const value = [...new Uint8Array(digest)]
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('');
        return { status: 'computed', algorithm: 'SHA-256', value };
      } catch (error) {
        return {
          status: 'unavailable',
          algorithm: 'SHA-256',
          value: null,
          message: safeErrorMessage(error)
        };
      }
    }

    async function buildModeCollections(collections) {
      const summaries = await Promise.all(collections.map(async collection => ({
        id: collection.id,
        label: collection.label,
        status: collection.status,
        uniqueUidCount: collection.uidSet.size,
        uidSetSha256: await sha256UidSet(collection.uidSet)
      })));
      const overlaps = [];
      for (let left = 0; left < collections.length; left += 1) {
        for (let right = left + 1; right < collections.length; right += 1) {
          overlaps.push(overlapSummary(collections[left], collections[right]));
        }
      }
      return { collections: summaries, overlaps };
    }

    function cursorConclusion(total, cursorReport) {
      if (cursorReport.status === 'inconclusive') {
        return { area: 'fans-main-cursor', status: 'inconclusive', finding: '游标链请求失败，本轮不足以判断可达范围。' };
      }
      if (total == null) {
        return { area: 'fans-main-cursor', status: 'inconclusive', finding: `取得 ${cursorReport.uniqueUidCount} 个唯一 UID，但总数未知。` };
      }
      if (cursorReport.overCoverage) {
        return {
          area: 'fans-main-cursor',
          status: 'inconclusive',
          finding: `总数 ${total}，却取得 ${cursorReport.uniqueUidCount} 个唯一 UID；分页数据与总数不一致。`
        };
      }
      if (cursorReport.uniqueUidCount > 1000) {
        return { area: 'fans-main-cursor', status: 'observed', finding: `本轮直接取得 ${cursorReport.uniqueUidCount} 个唯一 UID，已越过 1000。` };
      }
      if (total <= 1000) {
        return cursorReport.exactCoverage
          ? {
              area: 'fans-main-cursor',
              status: 'insufficient-sample',
              finding: `本轮完整取得 ${total} 个唯一 UID；总数未超过 1000，尚不足以验证第 1001 名。`
            }
          : {
              area: 'fans-main-cursor',
              status: 'bounded-observation',
              finding: `总数 ${total}，本轮只取得 ${cursorReport.uniqueUidCount} 个唯一 UID；该路线本轮未完整覆盖。`
            };
      }
      return {
        area: 'fans-main-cursor',
        status: 'bounded-observation',
        finding: `总数 ${total}，本轮游标链取得 ${cursorReport.uniqueUidCount} 个唯一 UID；没有越过 1000 的直接证据。`
      };
    }

    function makeReport(config) {
      return {
        reportType: REPORT_TYPE,
        reportVersion: REPORT_VERSION,
        generatedAt: new Date().toISOString(),
        runStatus: 'running',
        account: null,
        total: null,
        totalStatus: 'inconclusive',
        config: {
          pageSize: config.pageSize,
          requestDelayMs: config.requestDelayMs,
          numberedBoundaryThroughPage: config.boundaryThroughPage,
          numberedConsecutiveFailureLimit: config.numberedConsecutiveFailureLimit,
          cursorMaxSteps: config.cursorMaxSteps,
          cursorEmptyPageLimit: config.cursorEmptyPageLimit,
          cursorNoProgressPageLimit: config.cursorNoProgressPageLimit,
          includeReportedLastPageBoundary: config.includeReportedLastPageBoundary === true,
          requestTimeoutMs: config.requestTimeoutMs
        },
        tests: {},
        requests: [],
        conclusions: [],
        privacy: '只读 GET；请求日志移除认证参数；报告不包含 Cookie、SESSDATA、bili_jct、access_key、密码或验证码'
      };
    }

    async function runProbe(options = {}) {
      const config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
      const fetchImpl = options.fetchImpl
        ?? (typeof globalObject?.fetch === 'function' ? globalObject.fetch.bind(globalObject) : null);
      const requester = createRequester({
        fetchImpl,
        timeoutMs: config.requestTimeoutMs,
        clock: options.clock,
        signal: options.signal,
        onRequest: options.onRequest
      });
      const sleepFn = options.sleepFn ?? sleep;
      const report = makeReport(config);

      try {
        const nav = await requester.get('https://api.bilibili.com/x/web-interface/nav', 'session-nav');
        report.tests.session = { nav: requestSummary(nav), isLogin: nav?.data?.isLogin === true };
        if (!nav.ok || !nav.data?.isLogin || !positiveUid({ mid: nav.data?.mid })) {
          report.runStatus = 'inconclusive';
          report.conclusions.push({
            area: 'session',
            status: 'inconclusive',
            finding: nav.ok ? '当前会话没有可用的登录账号。' : '登录状态请求失败。'
          });
          return report;
        }
        const uid = positiveUid({ mid: nav.data.mid });
        report.account = { uid, name: String(nav.data.uname ?? '') };
        if (config.requestDelayMs > 0) await sleepFn(config.requestDelayMs);

        const statRaw = await requester.get(`https://api.bilibili.com/x/relation/stat?vmid=${uid}`, 'relation-stat');
        const stat = parseRelationStat(statRaw);
        report.tests.relationStat = { ...requestSummary(statRaw), ...stat };
        report.total = stat.total;
        report.totalStatus = stat.status;
        report.conclusions.push(stat.status === 'observed'
          ? { area: 'relation-stat', status: 'observed', finding: `接口报告总粉丝数 ${stat.total}。` }
          : { area: 'relation-stat', status: 'inconclusive', finding: '粉丝总数请求失败或字段无效；后续结果不得标记为完整。' });
        if (config.requestDelayMs > 0) await sleepFn(config.requestDelayMs);

        const unread = await probeUnread({
          request: requester.get,
          delayMs: config.requestDelayMs,
          sleepFn
        });
        report.tests.unread = unread;
        report.conclusions.push({
          area: 'followers-unread',
          status: unread.status,
          finding: unread.status === 'observed'
            ? '已记录 unread count/detail 以及 prior_unread、normal_unread、has_read 三组数组摘要。'
            : 'unread 请求未全部成功；相关结果为 inconclusive。'
        });
        if (config.requestDelayMs > 0) await sleepFn(config.requestDelayMs);

        const numbered = {};
        for (const endpoint of ['fans', 'followers']) {
          numbered[endpoint] = await probeNumberedCollection({
            endpoint,
            uid,
            total: stat.total,
            pageSize: config.pageSize,
            boundaryThroughPage: config.boundaryThroughPage,
            consecutiveFailureLimit: config.numberedConsecutiveFailureLimit,
            includeReportedLastPageBoundary: config.includeReportedLastPageBoundary,
            delayMs: config.requestDelayMs,
            sleepFn,
            request: requester.get
          });
          report.conclusions.push({
            area: `numbered-${endpoint}`,
            status: numbered[endpoint].report.coverageStatus,
            finding: `顺序页取得 ${numbered[endpoint].report.sequentialUniqueUidCount} 个唯一 UID；接口报告总数 ${stat.total ?? '未知'}。`
          });
          if (config.requestDelayMs > 0) await sleepFn(config.requestDelayMs);
        }
        report.tests.numbered = {
          fans: numbered.fans.report,
          followers: numbered.followers.report
        };

        const cursor = await probeCursorChain({
          uid,
          total: stat.total,
          pageSize: config.pageSize,
          lastAccessTs: unread.cursorLastAccessTs,
          maxSteps: config.cursorMaxSteps,
          emptyPageLimit: config.cursorEmptyPageLimit,
          noProgressPageLimit: config.cursorNoProgressPageLimit,
          delayMs: config.requestDelayMs,
          sleepFn,
          request: requester.get
        });
        report.tests.cursorFansMain = cursor.report;
        report.conclusions.push(cursorConclusion(stat.total, cursor.report));
        if (config.requestDelayMs > 0) await sleepFn(config.requestDelayMs);

        const creator = await runCreatorCenter({
          uid,
          request: requester.get,
          delayMs: config.requestDelayMs,
          sleepFn
        });
        report.tests.creatorCenter = creator;
        report.conclusions.push({ area: 'creator-center', status: creator.status, finding: creator.conclusion });

        report.tests.modeCollections = await buildModeCollections([
          {
            id: 'numbered-fans-desc',
            label: 'x/relation/fans 普通 pn/order=desc 顺序页',
            status: numbered.fans.report.coverageStatus === 'inconclusive' ? 'inconclusive' : 'observed',
            uidSet: numbered.fans.uidSet
          },
          {
            id: 'numbered-followers-desc',
            label: 'x/relation/followers 普通 pn/order=desc 顺序页',
            status: numbered.followers.report.coverageStatus === 'inconclusive' ? 'inconclusive' : 'observed',
            uidSet: numbered.followers.uidSet
          },
          {
            id: 'fans-main-cursor',
            label: 'x/relation/fans from=main 官方游标链',
            status: cursor.report.status,
            uidSet: cursor.uidSet
          }
        ]);
        report.runStatus = 'completed';
        return report;
      } catch (error) {
        report.runStatus = 'inconclusive';
        const cancelled = options.signal?.aborted === true || error?.name === 'AbortError';
        report.fatalError = {
          errorClass: cancelled ? 'cancelled' : 'unexpected',
          message: cancelled ? '探测已由用户取消' : safeErrorMessage(error)
        };
        report.conclusions.push({
          area: 'run',
          status: 'inconclusive',
          finding: cancelled
            ? '探测由用户取消；未完成的部分不作判断。'
            : '探测流程出现未预期错误，未完成的部分不作判断。'
        });
        return report;
      } finally {
        report.requests = requester.requests;
        report.finishedAt = new Date().toISOString();
      }
    }

    function redactUrlForShare(input) {
      try {
        const url = new URL(String(input));
        for (const key of ['vmid', 'tmid']) {
          if (url.searchParams.has(key)) url.searchParams.set(key, 'SELF_UID');
        }
        return url.toString();
      } catch {
        return String(input ?? '');
      }
    }

    function makeShareReport(report) {
      const clone = JSON.parse(JSON.stringify(report ?? {}));
      const privateAccountUid = positiveUid({ mid: report?.account?.uid });
      const privateAccountName = String(report?.account?.name ?? '');

      function scrubKnownIdentityText(value) {
        let text = String(value);
        text = text.replace(/\b(vmid|tmid)=\d+\b/gi, '$1=SELF_UID');
        if (privateAccountUid) {
          const uidText = String(privateAccountUid);
          text = text.replace(
            new RegExp(`(^|\\D)${uidText}(?=\\D|$)`, 'g'),
            (_match, prefix) => `${prefix}SELF_UID`
          );
        }
        if (privateAccountName) {
          text = text.replaceAll(privateAccountName, 'ACCOUNT_NAME');
        }
        return text;
      }

      function scrub(value, key = '') {
        if (Array.isArray(value)) {
          if (key === 'params') {
            return value.map(item => {
              if (!item || typeof item !== 'object') return item;
              const copied = { ...item };
              if (['vmid', 'tmid'].includes(String(copied.name))) copied.value = 'SELF_UID';
              return scrub(copied);
            });
          }
          return value.map(item => scrub(item));
        }
        if (typeof value === 'string') return scrubKnownIdentityText(value);
        if (!value || typeof value !== 'object') return value;
        const output = {};
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          if (nestedKey === 'url' && typeof nestedValue === 'string') {
            output[nestedKey] = scrubKnownIdentityText(redactUrlForShare(nestedValue));
          } else if (['firstUid', 'lastUid'].includes(nestedKey)) {
            output[nestedKey] = nestedValue == null ? null : 'UID_REDACTED';
          } else {
            output[nestedKey] = scrub(nestedValue, nestedKey);
          }
        }
        return output;
      }

      const shared = scrub(clone);
      if (shared.account) shared.account = { uid: 'SELF_UID', name: 'ACCOUNT_NAME' };
      shared.shareReport = true;
      shared.privacy =
        '默认分享版：账号 UID/昵称、vmid/tmid 与每页首尾 UID 已替换；只读 GET；不含登录凭据。';
      return shared;
    }

    function downloadReport(report, environment = globalObject, options = {}) {
      if (!environment?.document?.body || typeof environment.Blob !== 'function' || !environment.URL?.createObjectURL) return false;
      const payload = options.raw === true ? report : makeShareReport(report);
      const blob = new environment.Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const objectUrl = environment.URL.createObjectURL(blob);
      const anchor = environment.document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = options.raw === true
        ? `B站粉丝候选接口测试_v2_原始私有_${new Date().toISOString().replaceAll(':', '-')}.json`
        : `B站粉丝候选接口测试_v2_分享脱敏_${new Date().toISOString().replaceAll(':', '-')}.json`;
      environment.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => environment.URL.revokeObjectURL(objectUrl), 10000);
      return true;
    }

    async function runAndPublish(options = {}) {
      const environment = options.environment ?? globalObject;
      const report = await runProbe(options);
      if (environment) environment[REPORT_GLOBAL] = report;
      downloadReport(report, environment);
      environment?.console?.log?.('[粉丝接口探测完成 v2]', report);
      const cursorCount = report.tests?.cursorFansMain?.uniqueUidCount ?? 0;
      const message = report.runStatus === 'completed'
        ? `测试完成。总数：${report.total ?? '未知'}；官方游标链唯一 UID：${cursorCount}。已下载默认脱敏分享版；原始报告只保留在当前页面内存。`
        : '测试结果为 inconclusive；已下载默认脱敏分享版，可据其中失败类别继续排查。';
      if (typeof environment?.alert === 'function') environment.alert(message);
      return report;
    }

    function estimatedRequestCount(config = DEFAULT_CONFIG) {
      const boundary = Math.max(1, finiteNumber(config.boundaryThroughPage) ?? DEFAULT_CONFIG.boundaryThroughPage);
      const cursor = Math.max(1, finiteNumber(config.cursorMaxSteps) ?? DEFAULT_CONFIG.cursorMaxSteps);
      const optionalFarBoundary = config.includeReportedLastPageBoundary === true ? 4 : 0;
      // nav + stat + unread(2) + two numbered routes + cursor + creator(6)
      return 10 + (2 * (boundary + optionalFarBoundary)) + cursor;
    }

    function mountLauncher(api, environment = globalObject) {
      const documentObject = environment?.document;
      if (!documentObject?.body) return null;
      const launcherId = '__bili_follower_endpoint_probe_launcher__';
      const existing = documentObject.getElementById(launcherId);
      if (existing) return existing;

      const panel = documentObject.createElement('section');
      panel.id = launcherId;
      panel.style.cssText = [
        'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483647',
        'width:min(340px,calc(100vw - 24px))', 'padding:12px', 'border-radius:10px',
        'background:#fff', 'color:#222', 'box-shadow:0 4px 20px #0004',
        'font:13px/1.5 system-ui,sans-serif'
      ].join(';');
      const title = documentObject.createElement('strong');
      title.textContent = '粉丝接口只读探测器 v2';
      const detail = documentObject.createElement('div');
      detail.textContent =
        `手动启动；默认最多约 ${estimatedRequestCount(DEFAULT_CONFIG)} 个 GET。` +
        '生成文件默认替换账号身份与首尾 UID。';
      detail.style.cssText = 'margin:6px 0;color:#555';
      const status = documentObject.createElement('div');
      status.textContent = '尚未启动。';
      status.style.cssText = 'margin:6px 0;white-space:pre-wrap';
      const start = documentObject.createElement('button');
      start.type = 'button';
      start.textContent = '开始只读探测';
      const cancel = documentObject.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '取消';
      cancel.disabled = true;
      cancel.style.marginLeft = '8px';
      panel.append(title, detail, status, start, cancel);
      documentObject.body.appendChild(panel);

      const runState = environment[api.RUN_GUARD];
      start.addEventListener('click', async () => {
        if (runState.status === 'running') return;
        const controller = new AbortController();
        const estimate = estimatedRequestCount(DEFAULT_CONFIG);
        runState.status = 'running';
        runState.startedAt = new Date().toISOString();
        runState.finishedAt = null;
        runState.error = null;
        runState.controller = controller;
        start.disabled = true;
        cancel.disabled = false;
        status.textContent = `运行中：已完成请求 0 / 最多约 ${estimate}`;
        try {
          const report = await api.runAndPublish({
            environment,
            signal: controller.signal,
            onRequest(_record, count) {
              status.textContent = `运行中：已完成请求 ${count} / 最多约 ${estimate}`;
            }
          });
          runState.status = report.fatalError?.errorClass === 'cancelled'
            ? 'cancelled'
            : report.runStatus;
          status.textContent = runState.status === 'cancelled'
            ? '已取消；已完成部分保留为 inconclusive 脱敏报告。'
            : `已结束：${report.runStatus}；请求 ${report.requests?.length ?? 0} 个。`;
        } catch (error) {
          runState.status = 'inconclusive';
          runState.error = { errorClass: 'launcher', message: safeErrorMessage(error) };
          status.textContent = `启动器错误：${runState.error.message}`;
        } finally {
          runState.finishedAt = new Date().toISOString();
          runState.controller = null;
          start.disabled = false;
          cancel.disabled = true;
        }
      });
      cancel.addEventListener('click', () => {
        runState.controller?.abort();
        cancel.disabled = true;
        status.textContent = '正在取消当前请求……';
      });
      return panel;
    }

    return {
      API_GLOBAL,
      DEFAULT_CONFIG,
      REPORT_GLOBAL,
      REPORT_TYPE,
      REPORT_VERSION,
      RUN_GUARD,
      buildModeCollections,
      collectArraySummaries,
      createRequester,
      downloadReport,
      estimatedRequestCount,
      literalParameters,
      makeShareReport,
      mountLauncher,
      parseRelationStat,
      planNumberedPages,
      probeCursorChain,
      probeNumberedCollection,
      probeUnread,
      requestSummary,
      runAndPublish,
      runCreatorCenter,
      runProbe,
      sha256UidSet,
      summariseArray
    };
  }

  try {
    const api = createProbeApi();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (!globalObject) return;
    globalObject[api.API_GLOBAL] = api;

    const isBrowser = typeof globalObject.document !== 'undefined' && typeof globalObject.fetch === 'function';
    if (!isBrowser) return;
    if (globalObject[api.RUN_GUARD]) {
      api.mountLauncher(api, globalObject);
      globalObject.console?.info?.('[粉丝接口探测器 v2] 本页已有启动器，跳过重复挂载。');
      return;
    }

    const runState = {
      status: 'idle',
      startedAt: null,
      finishedAt: null,
      error: null,
      controller: null
    };
    globalObject[api.RUN_GUARD] = runState;
    api.mountLauncher(api, globalObject);
  } catch (error) {
    globalObject?.console?.error?.('[粉丝接口探测器 v2] 初始化错误', {
      errorClass: 'initialisation',
      message: String(error?.message ?? error)
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
