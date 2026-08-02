// ==UserScript==
// @name         B站粉丝快照测试版（手机/桌面）
// @namespace    https://github.com/HiiragiNemu/Bilibili-Follower-Snapshot
// @version      0.2.0-test
// @description  单接口整轮读取当前粉丝快照，严格校验后比较，并可在页面保持打开时定时监测
// @author       HiiragiNemu
// @match        https://space.bilibili.com/*
// @match        https://www.bilibili.com/h5/follow/newFans*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @downloadURL  https://raw.githubusercontent.com/HiiragiNemu/Bilibili-Follower-Snapshot/test/mobile-endpoint-probe/userscript/bilibili-follower-mobile-test.user.js
// @updateURL    https://raw.githubusercontent.com/HiiragiNemu/Bilibili-Follower-Snapshot/test/mobile-endpoint-probe/userscript/bilibili-follower-mobile-test.user.js
// ==/UserScript==

(async () => {
  'use strict';

  const CONFIG = Object.freeze({
    pageSize: 50,
    requestDelayMs: 350,
    maxRetries: 3,
    retryBaseDelayMs: 900,
    requestTimeoutMs: 15000,
    noProgressPageLimit: 2,
    fallbackPageGuard: 10000,
    knownFollowerDetailLimit: 1000,
    defaultMonitorIntervalMs: 5 * 60 * 1000,
    endpointCandidates: Object.freeze([
      Object.freeze({
        name: 'x/relation/fans',
        buildUrl(uid, page, pageSize) {
          const params = new URLSearchParams({
            vmid: String(uid),
            pn: String(page),
            ps: String(pageSize),
            order: 'desc'
          });
          return `https://api.bilibili.com/x/relation/fans?${params}`;
        }
      }),
      Object.freeze({
        name: 'x/relation/followers',
        buildUrl(uid, page, pageSize) {
          const params = new URLSearchParams({
            vmid: String(uid),
            pn: String(page),
            ps: String(pageSize),
            order: 'desc'
          });
          return `https://api.bilibili.com/x/relation/followers?${params}`;
        }
      })
    ])
  });

  const LAST_COMPLETE_PREFIX = 'biliFollowerMobileLastComplete:';
  const LAST_NOTICE_PREFIX = 'biliFollowerMobileLastNotice:';
  const PENDING_CHANGE_PREFIX = 'biliFollowerMobilePendingChange:';
  const PENDING_COMPARISON_PREFIX = 'biliFollowerMobilePendingComparison:';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function uidOf(value) {
    const uid = Number(value?.uid ?? value?.mid ?? value);
    return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
  }

  function parseCanonicalNonNegativeInteger(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (
      typeof value === 'string' &&
      /^(?:0|[1-9]\d*)$/.test(value)
    ) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
  }

  function normalize(item) {
    const uid = uidOf(item);
    if (!uid) return null;
    const timestamp = Number(item?.mtime ?? item?.followTimestamp ?? 0) || null;
    return {
      uid,
      name: String(item?.uname ?? item?.name ?? ''),
      sign: String(item?.sign ?? ''),
      face: String(item?.face ?? ''),
      followTimestamp: timestamp,
      followTime: timestamp
        ? new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false })
        : ''
    };
  }

  function unique(list) {
    const map = new Map();
    for (const raw of list || []) {
      const item = normalize(raw);
      if (item && !map.has(item.uid)) map.set(item.uid, item);
    }
    return [...map.values()];
  }

  function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function fnv1aId(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Execute a GET request with bounded exponential backoff. The request log only
   * contains the fixed API URL, status/code, timing and error text; it never
   * reads or records cookies, access keys, CSRF tokens, passwords or captchas.
   */
  async function requestJson(url, label, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const sleepFn = options.sleepFn || sleep;
    const setTimeoutFn = options.setTimeoutFn || setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    const AbortControllerImpl =
      options.AbortControllerImpl || globalThis.AbortController;
    const requestLog = options.requestLog || [];
    const maxRetries = options.maxRetries ?? CONFIG.maxRetries;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? CONFIG.retryBaseDelayMs;
    const requestedTimeoutMs = Number(
      options.requestTimeoutMs ?? CONFIG.requestTimeoutMs
    );
    const requestTimeoutMs = Number.isFinite(requestedTimeoutMs)
      ? Math.max(1, Math.min(Math.round(requestedTimeoutMs), 120000))
      : CONFIG.requestTimeoutMs;
    const onRetry = options.onRetry || (() => {});
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startedAt = nowMs();
      const entry = {
        at: new Date().toISOString(),
        label,
        method: 'GET',
        url,
        attempt,
        httpStatus: null,
        apiCode: null,
        apiMessage: '',
        timeoutMs: requestTimeoutMs,
        timedOut: false,
        elapsedMs: null,
        ok: false,
        error: ''
      };
      let logged = false;
      let timeoutId = null;

      try {
        if (typeof AbortControllerImpl !== 'function') {
          throw new Error('当前浏览器缺少 AbortController，不能执行有界请求。');
        }
        const controller = new AbortControllerImpl();
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeoutFn(() => {
            entry.timedOut = true;
            try {
              controller.abort('request-timeout');
            } catch {
              controller.abort();
            }
            const timeoutError = new Error(`请求超时（${requestTimeoutMs}ms）`);
            timeoutError.name = 'TimeoutError';
            reject(timeoutError);
          }, requestTimeoutMs);
        });
        const fetchAndParse = (async () => {
          const response = await fetchImpl(url, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'application/json, text/plain, */*' },
            signal: controller.signal
          });
          entry.httpStatus = response.status;

          const text = await response.text();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            throw new Error(`返回内容不是 JSON（HTTP ${response.status}）`);
          }

          entry.apiCode = typeof json?.code === 'number' ? json.code : null;
          entry.apiMessage = String(json?.message ?? json?.msg ?? '').slice(0, 180);

          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (typeof json?.code === 'number' && json.code !== 0) {
            throw new Error(`接口 code=${json.code}；${entry.apiMessage}`);
          }
          return json;
        })();
        const json = await Promise.race([fetchAndParse, timeoutPromise]);
        clearTimeoutFn(timeoutId);
        timeoutId = null;

        entry.ok = true;
        entry.elapsedMs = Math.round(nowMs() - startedAt);
        requestLog.push(entry);
        logged = true;
        return json;
      } catch (error) {
        if (timeoutId !== null) {
          clearTimeoutFn(timeoutId);
          timeoutId = null;
        }
        if (entry.timedOut && error?.name !== 'TimeoutError') {
          lastError = new Error(`请求超时（${requestTimeoutMs}ms）`);
          lastError.name = 'TimeoutError';
        } else {
          lastError = error;
        }
        if (!logged) {
          entry.elapsedMs = Math.round(nowMs() - startedAt);
          entry.error = String(lastError?.message || lastError);
          requestLog.push(entry);
        }

        if (attempt < maxRetries) {
          const delayMs = retryBaseDelayMs * Math.pow(2, attempt - 1);
          onRetry({ label, attempt, delayMs, error: lastError });
          await sleepFn(delayMs);
        }
      }
    }

    throw lastError || new Error(`${label} 请求失败。`);
  }

  async function scanEndpointRound(options) {
    const {
      uid,
      initialTotal,
      verifiedTotal = initialTotal,
      endpoint,
      fetchPage,
      onProgress = () => {},
      sleepFn = sleep,
      pageSize = CONFIG.pageSize,
      requestDelayMs = CONFIG.requestDelayMs,
      noProgressPageLimit = CONFIG.noProgressPageLimit,
      fallbackPageGuard = CONFIG.fallbackPageGuard
    } = options;

    const followers = new Map();
    const reportedTotals = new Set();
    let allReadPagesHaveValidReportedTotal = true;
    const maxPages = Number.isSafeInteger(verifiedTotal) && verifiedTotal >= 0
      ? Math.max(1, Math.ceil(verifiedTotal / pageSize) + 2)
      : fallbackPageGuard;
    let noProgressPages = 0;
    let stopReason = '';
    let page = 1;

    try {
      for (; page <= maxPages; page++) {
        onProgress({ endpoint: endpoint.name, page, uniqueCount: followers.size });
        const result = await fetchPage({ uid, page, pageSize, endpoint });

        if (result?.endpoint && result.endpoint !== endpoint.name) {
          throw new Error(`接口身份不一致：预期 ${endpoint.name}，实际 ${result.endpoint}`);
        }
        if (!Array.isArray(result?.list)) {
          throw new Error(`第 ${page} 页缺少 list 数组`);
        }
        if (Number.isSafeInteger(result.total) && result.total >= 0) {
          reportedTotals.add(result.total);
        } else {
          allReadPagesHaveValidReportedTotal = false;
        }

        const before = followers.size;
        for (const raw of result.list) {
          const item = normalize(raw);
          if (item && !followers.has(item.uid)) followers.set(item.uid, item);
        }
        const added = followers.size - before;

        if (result.list.length === 0) {
          stopReason = `第 ${page} 页返回空列表`;
          break;
        }

        noProgressPages = added === 0 ? noProgressPages + 1 : 0;
        if (noProgressPages >= noProgressPageLimit) {
          stopReason = `连续 ${noProgressPages} 页没有新增 UID`;
          break;
        }

        const expectedTotal = Math.max(verifiedTotal || 0, ...reportedTotals, 0);
        if (followers.size >= expectedTotal) {
          stopReason = '已达到或超过本轮可验证报告总数';
          break;
        }
        if (result.list.length < pageSize) {
          stopReason = `第 ${page} 页不足 ${pageSize} 条`;
          break;
        }

        if (requestDelayMs > 0) await sleepFn(requestDelayMs);
      }
    } catch (cause) {
      const error = new Error(`${endpoint.name} 第 ${page} 页失败：${cause?.message || cause}`);
      error.round = {
        endpoint: endpoint.name,
        succeeded: false,
        failedPage: page,
        discardedUniqueTotal: followers.size,
        error: String(cause?.message || cause)
      };
      throw error;
    }

    if (!stopReason && page > maxPages) {
      stopReason = `达到安全页数 ${maxPages}`;
    }

    const requiredReportedTotal = Math.max(
      Number.isSafeInteger(verifiedTotal) && verifiedTotal >= 0 ? verifiedTotal : 0,
      ...reportedTotals,
      0
    );
    const exactCoverage = followers.size === requiredReportedTotal;
    const listTotalsAgreeWithVerified =
      allReadPagesHaveValidReportedTotal &&
      reportedTotals.size === 1 &&
      [...reportedTotals][0] === verifiedTotal;
    return {
      endpoint: endpoint.name,
      followers: [...followers.values()].sort(
        (a, b) => (b.followTimestamp || 0) - (a.followTimestamp || 0)
      ),
      listEndpointReportedTotals: [...reportedTotals],
      allReadPagesHaveValidReportedTotal,
      listEndpointTotalsStable: reportedTotals.size === 1,
      listTotalsAgreeWithVerified,
      requiredReportedTotal,
      exactCoverage,
      underCoverage: followers.size < requiredReportedTotal,
      overCoverage: followers.size > requiredReportedTotal,
      pagesRead: Math.min(page, maxPages),
      stopReason
    };
  }

  /**
   * Each endpoint gets an isolated full round. If any page exhausts its retries,
   * that round's map is discarded and the backup endpoint restarts at page 1.
   */
  async function scanFollowersWithFailover(options) {
    const endpoints = options.endpoints || CONFIG.endpointCandidates;
    const roundAttempts = [];
    const failures = [];
    const incompleteRounds = [];

    for (const endpoint of endpoints) {
      try {
        const result = await scanEndpointRound({ ...options, endpoint });
        const coverageAccepted =
          result.exactCoverage && result.listTotalsAgreeWithVerified;
        const attempt = {
          endpoint: endpoint.name,
          succeeded: true,
          coverageAccepted,
          discardedDueToCoverage: !coverageAccepted,
          pagesRead: result.pagesRead,
          uniqueTotal: result.followers.length,
          requiredReportedTotal: result.requiredReportedTotal,
          underCoverage: result.underCoverage,
          overCoverage: result.overCoverage,
          allReadPagesHaveValidReportedTotal:
            result.allReadPagesHaveValidReportedTotal,
          listTotalsAgreeWithVerified: result.listTotalsAgreeWithVerified,
          stopReason: result.stopReason
        };
        roundAttempts.push(attempt);
        if (coverageAccepted) return { ...result, roundAttempts };
        incompleteRounds.push({ result, attempt });
      } catch (error) {
        const failedRound = error.round || {
          endpoint: endpoint.name,
          succeeded: false,
          error: String(error?.message || error)
        };
        roundAttempts.push(failedRound);
        failures.push(`${endpoint.name}: ${failedRound.error}`);
      }
    }

    if (incompleteRounds.length) {
      const selected = incompleteRounds.reduce((best, candidate) => {
        if (!best) return candidate;
        if (
          candidate.result.listTotalsAgreeWithVerified !==
          best.result.listTotalsAgreeWithVerified
        ) {
          return candidate.result.listTotalsAgreeWithVerified ? candidate : best;
        }
        const candidateGap = Math.abs(
          candidate.result.followers.length - candidate.result.requiredReportedTotal
        );
        const bestGap = Math.abs(
          best.result.followers.length - best.result.requiredReportedTotal
        );
        return candidateGap < bestGap ? candidate : best;
      }, null);
      selected.attempt.selectedAsIncompleteFallback = true;
      return {
        ...selected.result,
        allEndpointRoundsIncomplete: true,
        roundAttempts
      };
    }

    const error = new Error(`所有粉丝接口整轮读取均失败：${failures.join('；')}`);
    error.roundAttempts = roundAttempts;
    throw error;
  }

  function evaluateSnapshotIntegrity(options) {
    const {
      initialTotal,
      finalTotal,
      listEndpointReportedTotals = [],
      listEndpointTotalsStable = true,
      uniqueTotal
    } = options;
    const initialTotalValid =
      Number.isSafeInteger(initialTotal) && initialTotal >= 0;
    const finalTotalValid =
      Number.isSafeInteger(finalTotal) && finalTotal >= 0;
    const statStable =
      initialTotalValid && finalTotalValid && finalTotal === initialTotal;
    const followerDelta =
      Number.isSafeInteger(initialTotal) && Number.isSafeInteger(finalTotal)
        ? finalTotal - initialTotal
        : null;
    const validListTotals = listEndpointReportedTotals.filter(
      total => Number.isSafeInteger(total) && total >= 0
    );
    const listTotalsValid =
      listEndpointReportedTotals.length > 0 &&
      validListTotals.length === listEndpointReportedTotals.length;
    const actualListTotalsStable = new Set(validListTotals).size === 1;
    const effectiveListTotalsStable =
      listEndpointTotalsStable === true &&
      listTotalsValid &&
      actualListTotalsStable;
    const listTotalsAgreeWithStat =
      statStable &&
      listTotalsValid &&
      validListTotals.every(total => total === initialTotal);
    const unifiedReportedTotal = listTotalsAgreeWithStat
      ? initialTotal
      : null;
    const reportedTotalForCoverage = Math.max(
      initialTotalValid ? initialTotal : 0,
      ...(finalTotalValid ? [finalTotal] : []),
      ...validListTotals,
      0
    );
    const uniqueTotalValid =
      Number.isSafeInteger(uniqueTotal) &&
      uniqueTotal >= 0;
    const exactUniqueTotal =
      uniqueTotalValid &&
      unifiedReportedTotal !== null &&
      uniqueTotal === unifiedReportedTotal;
    const overCoverage =
      uniqueTotalValid &&
      unifiedReportedTotal !== null &&
      uniqueTotal > unifiedReportedTotal;
    const underCoverage =
      uniqueTotalValid &&
      unifiedReportedTotal !== null &&
      uniqueTotal < unifiedReportedTotal;
    const complete =
      statStable &&
      effectiveListTotalsStable &&
      listTotalsAgreeWithStat &&
      exactUniqueTotal;
    return {
      statStable,
      followerDelta,
      unifiedReportedTotal,
      reportedTotalForCoverage,
      listEndpointTotalsStable: effectiveListTotalsStable,
      listTotalsAgreeWithStat,
      exactUniqueTotal,
      uniqueCoverage: exactUniqueTotal,
      overCoverage,
      underCoverage,
      complete
    };
  }

  function validateCompleteSnapshot(snapshot, label) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error(`${label}不是快照对象。`);
    }
    const targetUid = uidOf(snapshot.targetUid);
    if (!targetUid) throw new Error(`${label}缺少有效 targetUid。`);
    if (snapshot.complete !== true) {
      throw new Error(`${label}未通过 complete===true 完整性校验。`);
    }
    if (!Array.isArray(snapshot.followers)) {
      throw new Error(`${label}缺少 followers 数组。`);
    }

    const followers = unique(snapshot.followers);
    if (followers.length !== snapshot.followers.length) {
      throw new Error(`${label}含无效或重复 UID，与完整快照声明不一致。`);
    }
    const exportedUniqueTotal = snapshot.exportedUniqueTotal;
    if (
      typeof exportedUniqueTotal !== 'number' ||
      !Number.isSafeInteger(exportedUniqueTotal) ||
      exportedUniqueTotal < 0
    ) {
      throw new Error(`${label}缺少有效 exportedUniqueTotal。`);
    }
    if (exportedUniqueTotal !== followers.length) {
      throw new Error(`${label}的 exportedUniqueTotal 与 followers 不一致。`);
    }

    const parseReportedTotal = (value, field) => {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        throw new Error(`${label}的 ${field} 不是有效非负整数。`);
      }
      return value;
    };
    if (
      !Object.prototype.hasOwnProperty.call(snapshot, 'initialReportedTotal') ||
      !Object.prototype.hasOwnProperty.call(snapshot, 'finalReportedTotal')
    ) {
      throw new Error(`${label}缺少扫描前后报告总数，不能证明完整。`);
    }
    const initialReportedTotal = parseReportedTotal(
      snapshot.initialReportedTotal,
      'initialReportedTotal'
    );
    const finalReportedTotal = parseReportedTotal(
      snapshot.finalReportedTotal,
      'finalReportedTotal'
    );
    let listReportedTotals = [];
    if (Object.prototype.hasOwnProperty.call(snapshot, 'listEndpointReportedTotals')) {
      if (!Array.isArray(snapshot.listEndpointReportedTotals)) {
        throw new Error(`${label}的 listEndpointReportedTotals 不是数组。`);
      }
      listReportedTotals = snapshot.listEndpointReportedTotals.map((value, index) =>
        parseReportedTotal(value, `listEndpointReportedTotals[${index}]`)
      );
    } else if (
      Object.prototype.hasOwnProperty.call(snapshot, 'listEndpointReportedTotal') &&
      snapshot.listEndpointReportedTotal !== null &&
      snapshot.listEndpointReportedTotal !== undefined
    ) {
      listReportedTotals = [
        parseReportedTotal(
          snapshot.listEndpointReportedTotal,
          'listEndpointReportedTotal'
        )
      ];
    }
    const declaredTotals = [
      initialReportedTotal,
      finalReportedTotal,
      ...listReportedTotals
    ];
    if (declaredTotals.some(total => total !== initialReportedTotal)) {
      throw new Error(`${label}的扫描前、扫描后或分页报告总数互相不一致。`);
    }
    if (
      Object.prototype.hasOwnProperty.call(snapshot, 'reportedTotalForCoverage') &&
      parseReportedTotal(
        snapshot.reportedTotalForCoverage,
        'reportedTotalForCoverage'
      ) !== initialReportedTotal
    ) {
      throw new Error(`${label}的 reportedTotalForCoverage 与统一报告总数不一致。`);
    }
    if (followers.length !== initialReportedTotal) {
      throw new Error(`${label}的唯一 followers 数不等于统一报告总数。`);
    }

    return {
      targetUid,
      followers,
      unifiedReportedTotal: initialReportedTotal
    };
  }

  function compareCompleteSnapshots(previous, current, previousFileName = '') {
    const oldSnapshot = validateCompleteSnapshot(previous, '旧快照');
    const newSnapshot = validateCompleteSnapshot(current, '当前快照');
    if (oldSnapshot.targetUid !== newSnapshot.targetUid) {
      throw new Error(
        `旧快照 UID ${oldSnapshot.targetUid} 与当前 UID ${newSnapshot.targetUid} 不一致。`
      );
    }

    const oldMap = new Map(oldSnapshot.followers.map(item => [item.uid, item]));
    const newMap = new Map(newSnapshot.followers.map(item => [item.uid, item]));
    const removed = [...oldMap.values()].filter(item => !newMap.has(item.uid));
    const added = [...newMap.values()].filter(item => !oldMap.has(item.uid));

    const comparison = {
      reportType: 'bilibili-follower-snapshot-comparison',
      reportVersion: 'mobile-test-0.2.0',
      generatedAt: new Date().toISOString(),
      targetUid: newSnapshot.targetUid,
      targetName: String(current.targetName || ''),
      previousFileName,
      previousGeneratedAt: previous.generatedAt ?? null,
      currentGeneratedAt: current.generatedAt ?? null,
      previousComplete: true,
      currentComplete: true,
      confidence: 'high',
      previousCount: oldSnapshot.followers.length,
      currentCount: newSnapshot.followers.length,
      removedCount: removed.length,
      addedCount: added.length,
      removed,
      added,
      interpretation:
        'removed 为完整同账号快照之间的关系已消失候选，仍不能单独区分主动取关、注销、封禁、拉黑、平台清理或被移除。'
    };
    comparison.comparisonId = stableComparisonId(comparison);
    return comparison;
  }

  function clearComparison(targetState, controls = {}) {
    targetState.comparison = null;
    if (controls.saveDiff) controls.saveDiff.disabled = true;
    if (controls.ackDiff) controls.ackDiff.disabled = true;
  }

  function invalidateForNewScan(targetState, controls = {}) {
    targetState.current = null;
    clearComparison(targetState, controls);
    targetState.pendingChange = null;
    targetState.requestLog = [];
    targetState.warnings = [];
    targetState.errors = [];
    if (controls.saveCurrent) controls.saveCurrent.disabled = true;
  }

  function lastCompleteKey(uid) {
    return `${LAST_COMPLETE_PREFIX}${uid}`;
  }

  function snapshotGeneratedAtMs(report, label) {
    if (typeof report?.generatedAt !== 'string' || !report.generatedAt) {
      throw new Error(`${label}缺少 generatedAt。`);
    }
    const value = Date.parse(report.generatedAt);
    if (!Number.isFinite(value)) throw new Error(`${label}的 generatedAt 无效。`);
    return value;
  }

  function tryPersistLatestComplete(report, storage) {
    if (report?.complete !== true) {
      return {
        eligible: false,
        attempted: false,
        saved: false,
        key: report?.targetUid ? lastCompleteKey(report.targetUid) : null,
        error: ''
      };
    }

    const key = lastCompleteKey(report.targetUid);
    if (
      !storage ||
      typeof storage.getItem !== 'function' ||
      typeof storage.setItem !== 'function'
    ) {
      return { eligible: true, attempted: true, saved: false, key, error: '存储不可用' };
    }

    try {
      validateCompleteSnapshot(report, '待保存 lastComplete');
      const incomingGeneratedAtMs = snapshotGeneratedAtMs(
        report,
        '待保存 lastComplete'
      );
      // Re-read immediately before writing; a delayed/older tab must never move
      // the monotonic complete baseline backwards.
      const existingText = storage.getItem(key);
      if (existingText) {
        const existing = JSON.parse(existingText);
        validateCompleteSnapshot(existing, '已存 lastComplete');
        const existingGeneratedAtMs = snapshotGeneratedAtMs(
          existing,
          '已存 lastComplete'
        );
        if (existingGeneratedAtMs > incomingGeneratedAtMs) {
          return {
            eligible: true,
            attempted: true,
            saved: false,
            staleRejected: true,
            key,
            error: '待保存快照 generatedAt 早于已存 lastComplete，已拒绝回退基线'
          };
        }
      }
      const persisted = {
        ...report,
        storage: { latestCompleteSaved: true, key, error: '' }
      };
      storage.setItem(key, JSON.stringify(persisted));
      return {
        eligible: true,
        attempted: true,
        saved: true,
        staleRejected: false,
        key,
        error: ''
      };
    } catch (error) {
      return {
        eligible: true,
        attempted: true,
        saved: false,
        key,
        error: String(error?.message || error)
      };
    }
  }

  function readLastComplete(uid, storage) {
    const key = lastCompleteKey(uid);
    if (!storage || typeof storage.getItem !== 'function') {
      return { report: null, key, error: '存储不可用' };
    }
    try {
      const text = storage.getItem(key);
      if (!text) return { report: null, key, error: '' };
      const report = JSON.parse(text);
      const checked = validateCompleteSnapshot(report, '已存 lastComplete');
      if (checked.targetUid !== uidOf(uid)) {
        throw new Error('已存 lastComplete 的 targetUid 不匹配。');
      }
      return { report, key, error: '' };
    } catch (error) {
      return { report: null, key, error: String(error?.message || error) };
    }
  }

  function pendingChangeKey(uid) {
    return `${PENDING_CHANGE_PREFIX}${uid}`;
  }

  function pendingComparisonPrefix(uid) {
    return `${PENDING_COMPARISON_PREFIX}${uid}:`;
  }

  function stableComparisonId(comparison) {
    const removed = Array.isArray(comparison?.removed)
      ? comparison.removed.map(item => uidOf(item)).filter(Boolean).sort((a, b) => a - b)
      : [];
    const added = Array.isArray(comparison?.added)
      ? comparison.added.map(item => uidOf(item)).filter(Boolean).sort((a, b) => a - b)
      : [];
    const identity = JSON.stringify({
      targetUid: uidOf(comparison?.targetUid),
      previousGeneratedAt: String(comparison?.previousGeneratedAt || ''),
      currentGeneratedAt: String(comparison?.currentGeneratedAt || ''),
      removed,
      added
    });
    return `cmp-v1-${fnv1aId(identity)}`;
  }

  function pendingComparisonKey(uid, comparisonId) {
    return `${pendingComparisonPrefix(uid)}${comparisonId}`;
  }

  function validatePendingComparison(comparison, expectedUid = null) {
    if (!comparison || typeof comparison !== 'object') {
      throw new Error('pendingChange 缺少 comparison 对象。');
    }
    const targetUid = uidOf(comparison.targetUid);
    if (!targetUid || (expectedUid && targetUid !== uidOf(expectedUid))) {
      throw new Error('pendingChange comparison 的 targetUid 不匹配。');
    }
    if (
      comparison.previousComplete !== true ||
      comparison.currentComplete !== true ||
      comparison.confidence !== 'high'
    ) {
      throw new Error('pendingChange comparison 未通过完整性证据校验。');
    }
    if (!Array.isArray(comparison.removed) || !Array.isArray(comparison.added)) {
      throw new Error('pendingChange comparison 缺少差集数组。');
    }
    if (
      comparison.removedCount !== comparison.removed.length ||
      comparison.addedCount !== comparison.added.length
    ) {
      throw new Error('pendingChange comparison 的差集计数不一致。');
    }
    const comparisonId = stableComparisonId(comparison);
    if (
      comparison.comparisonId &&
      comparison.comparisonId !== comparisonId
    ) {
      throw new Error('pendingChange comparisonId 与内容不一致。');
    }
    return { ...comparison, comparisonId };
  }

  function normalizePendingChange(envelope, expectedUid = null) {
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('pendingChange 不是对象。');
    }
    const targetUid = uidOf(envelope.targetUid);
    if (!targetUid || (expectedUid && targetUid !== uidOf(expectedUid))) {
      throw new Error('pendingChange 的 targetUid 不匹配。');
    }
    const rawComparisons = Array.isArray(envelope.comparisons)
      ? envelope.comparisons
      : envelope.lastDetectedComparison
        ? [envelope.lastDetectedComparison]
        : [];
    if (!rawComparisons.length) throw new Error('pendingChange 没有待处理比较。');
    const comparisonMap = new Map();
    for (const rawComparison of rawComparisons) {
      const comparison = validatePendingComparison(rawComparison, targetUid);
      comparisonMap.set(comparison.comparisonId, comparison);
    }
    const comparisons = [...comparisonMap.values()].sort((a, b) =>
      String(a.currentGeneratedAt || a.generatedAt || '').localeCompare(
        String(b.currentGeneratedAt || b.generatedAt || '')
      ) || a.comparisonId.localeCompare(b.comparisonId)
    );
    return {
      reportType: 'bilibili-follower-monitor-pending-change',
      reportVersion: 'mobile-test-0.2.0',
      pending: true,
      targetUid,
      revision: String(envelope.revision || ''),
      createdAt: envelope.createdAt || comparisons[0].generatedAt || new Date().toISOString(),
      updatedAt: envelope.updatedAt || comparisons.at(-1).generatedAt || new Date().toISOString(),
      comparisons,
      lastDetectedComparison: comparisons.at(-1)
    };
  }

  function readPendingChange(uid, storage) {
    const key = pendingChangeKey(uid);
    if (!storage || typeof storage.getItem !== 'function') {
      return { envelope: null, key, error: '存储不可用' };
    }
    try {
      const text = storage.getItem(key);
      const storedEnvelope = text
        ? normalizePendingChange(JSON.parse(text), uid)
        : null;
      const comparisons = storedEnvelope
        ? [...storedEnvelope.comparisons]
        : [];
      if (typeof storage.key === 'function') {
        const itemPrefix = pendingComparisonPrefix(uid);
        for (let index = 0; index < Number(storage.length || 0); index++) {
          const itemKey = storage.key(index);
          if (!itemKey?.startsWith(itemPrefix)) continue;
          const itemText = storage.getItem(itemKey);
          if (!itemText) continue;
          comparisons.push(validatePendingComparison(JSON.parse(itemText), uid));
        }
      }
      if (!comparisons.length) return { envelope: null, key, error: '' };
      return {
        envelope: normalizePendingChange({
          targetUid: uid,
          revision: storedEnvelope?.revision || '',
          createdAt: storedEnvelope?.createdAt,
          updatedAt: storedEnvelope?.updatedAt,
          comparisons,
          lastDetectedComparison: storedEnvelope?.lastDetectedComparison
        }, uid),
        key,
        error: ''
      };
    } catch (error) {
      return { envelope: null, key, error: String(error?.message || error) };
    }
  }

  function readAnyPendingChange(storage) {
    if (
      !storage ||
      typeof storage.key !== 'function' ||
      typeof storage.getItem !== 'function'
    ) {
      return { envelope: null, key: null, error: '存储不可用' };
    }
    try {
      let selected = null;
      let selectedKey = null;
      const pendingUids = new Set();
      for (let index = 0; index < Number(storage.length || 0); index++) {
        const key = storage.key(index);
        if (key?.startsWith(PENDING_CHANGE_PREFIX)) {
          const uid = uidOf(key.slice(PENDING_CHANGE_PREFIX.length));
          if (uid) pendingUids.add(uid);
        } else if (key?.startsWith(PENDING_COMPARISON_PREFIX)) {
          const uidText = key.slice(PENDING_COMPARISON_PREFIX.length).split(':', 1)[0];
          const uid = uidOf(uidText);
          if (uid) pendingUids.add(uid);
        }
      }
      for (const uid of pendingUids) {
        const loaded = readPendingChange(uid, storage);
        if (loaded.error || !loaded.envelope) continue;
        const envelope = loaded.envelope;
        if (
          !selected ||
          String(envelope.updatedAt) > String(selected.updatedAt)
        ) {
          selected = envelope;
          selectedKey = loaded.key;
        }
      }
      return { envelope: selected, key: selectedKey, error: '' };
    } catch (error) {
      return { envelope: null, key: null, error: String(error?.message || error) };
    }
  }

  function tryPersistPendingChange(comparison, storage, existingEnvelope = null) {
    const checked = validatePendingComparison(comparison);
    const key = pendingChangeKey(checked.targetUid);
    if (
      !storage ||
      typeof storage.getItem !== 'function' ||
      typeof storage.setItem !== 'function'
    ) {
      return { attempted: true, saved: false, key, envelope: null, error: '存储不可用' };
    }

    try {
      // Store each evidence item under its stable ID first. Even if two tabs
      // race on the aggregate envelope, neither can overwrite the other's item.
      storage.setItem(
        pendingComparisonKey(checked.targetUid, checked.comparisonId),
        JSON.stringify(checked)
      );

      let lastEnvelope = existingEnvelope;
      let lastError = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        // Never trust the caller's cached envelope as the authoritative state.
        const loaded = readPendingChange(checked.targetUid, storage);
        if (loaded.error && loaded.error !== '存储不可用') {
          lastError = `读取既有 pendingChange 失败：${loaded.error}`;
          continue;
        }
        const comparisons = [
          ...(loaded.envelope?.comparisons || []),
          ...(lastEnvelope
            ? normalizePendingChange(lastEnvelope, checked.targetUid).comparisons
            : []),
          checked
        ];
        const revision =
          `rev-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}`;
        const envelope = normalizePendingChange({
          targetUid: checked.targetUid,
          revision,
          createdAt:
            loaded.envelope?.createdAt ||
            lastEnvelope?.createdAt ||
            checked.generatedAt,
          updatedAt: new Date().toISOString(),
          comparisons,
          lastDetectedComparison: checked
        }, checked.targetUid);
        storage.setItem(key, JSON.stringify(envelope));

        const verificationText = storage.getItem(key);
        if (!verificationText) {
          lastEnvelope = envelope;
          lastError = 'pendingChange 乐观校验未读回聚合记录';
          continue;
        }
        const verified = normalizePendingChange(
          JSON.parse(verificationText),
          checked.targetUid
        );
        const expectedIds = new Set(
          envelope.comparisons.map(item => item.comparisonId)
        );
        const verifiedIds = new Set(
          verified.comparisons.map(item => item.comparisonId)
        );
        if ([...expectedIds].every(id => verifiedIds.has(id))) {
          return {
            attempted: true,
            saved: true,
            key,
            envelope: verified,
            attempts: attempt,
            error: ''
          };
        }
        lastEnvelope = verified;
        lastError = 'pendingChange 乐观校验发现并发覆盖，正在重试';
      }
      return {
        attempted: true,
        saved: false,
        key,
        envelope: lastEnvelope,
        attempts: 3,
        error: lastError || 'pendingChange 乐观校验重试耗尽'
      };
    } catch (error) {
      return {
        attempted: true,
        saved: false,
        key,
        envelope: existingEnvelope,
        error: String(error?.message || error)
      };
    }
  }

  function persistDetectedChangeBeforeBaseline(
    comparison,
    report,
    storage,
    existingEnvelope = null
  ) {
    const pending = tryPersistPendingChange(
      comparison,
      storage,
      existingEnvelope
    );
    if (!pending.saved) {
      return {
        pending,
        baseline: { attempted: false, saved: false, error: 'pendingChange 未保存' },
        noticeEligible: false
      };
    }
    const baseline = tryPersistLatestComplete(report, storage);
    return {
      pending,
      baseline,
      noticeEligible: baseline.saved === true
    };
  }

  function tryClearPendingChange(uid, storage) {
    const key = pendingChangeKey(uid);
    if (!storage || typeof storage.removeItem !== 'function') {
      return { removed: false, key, error: '存储不可用' };
    }
    try {
      if (typeof storage.key === 'function') {
        const itemPrefix = pendingComparisonPrefix(uid);
        const itemKeys = [];
        for (let index = 0; index < Number(storage.length || 0); index++) {
          const itemKey = storage.key(index);
          if (itemKey?.startsWith(itemPrefix)) itemKeys.push(itemKey);
        }
        for (const itemKey of itemKeys) storage.removeItem(itemKey);
      }
      storage.removeItem(key);
      return { removed: true, key, error: '' };
    } catch (error) {
      return { removed: false, key, error: String(error?.message || error) };
    }
  }

  function changeFingerprint(comparison) {
    const removed = comparison.removed.map(item => item.uid).sort((a, b) => a - b);
    const added = comparison.added.map(item => item.uid).sort((a, b) => a - b);
    // Tie notification-only de-duplication to the persisted baseline, while
    // leaving the pending comparison evidence queue untouched.
    const text =
      `${comparison.targetUid}|base=${comparison.previousGeneratedAt || ''}` +
      `|-${removed.join(',')}|+${added.join(',')}`;
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function createPersistentStorageAdapter(scope = globalThis) {
    const gmGet = scope?.GM_getValue;
    const gmSet = scope?.GM_setValue;
    const gmDelete = scope?.GM_deleteValue;
    const gmList = scope?.GM_listValues;
    if (
      typeof gmGet === 'function' &&
      typeof gmSet === 'function' &&
      typeof gmDelete === 'function' &&
      typeof gmList === 'function'
    ) {
      const keys = () => {
        const values = gmList.call(scope);
        return Array.isArray(values) ? [...values].sort() : [];
      };
      return {
        storageKind: 'tampermonkey-isolated',
        get length() { return keys().length; },
        key(index) { return keys()[index] ?? null; },
        getItem(key) {
          const value = gmGet.call(scope, String(key), null);
          return value == null ? null : String(value);
        },
        setItem(key, value) { gmSet.call(scope, String(key), String(value)); },
        removeItem(key) { gmDelete.call(scope, String(key)); }
      };
    }

    try {
      return scope?.window?.localStorage ?? scope?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  // A test-only early exit keeps the browser script self-contained while letting
  // dependency-free Node regression tests exercise the same production functions.
  if (globalThis.__BILI_FOLLOWER_MOBILE_TEST_MODE__ === true) {
    globalThis.__BILI_FOLLOWER_MOBILE_TEST_HOOKS__ = Object.freeze({
      requestJson,
      parseCanonicalNonNegativeInteger,
      scanEndpointRound,
      scanFollowersWithFailover,
      evaluateSnapshotIntegrity,
      validateCompleteSnapshot,
      compareCompleteSnapshots,
      clearComparison,
      invalidateForNewScan,
      tryPersistLatestComplete,
      readLastComplete,
      snapshotGeneratedAtMs,
      validatePendingComparison,
      stableComparisonId,
      normalizePendingChange,
      readPendingChange,
      readAnyPendingChange,
      tryPersistPendingChange,
      persistDetectedChangeBeforeBaseline,
      tryClearPendingChange,
      changeFingerprint,
      createPersistentStorageAdapter
    });
    return;
  }

  const ID = '__bili_mobile_follower_test__';
  if (document.getElementById(ID)) return;

  const state = {
    current: null,
    comparison: null,
    pendingChange: null,
    requestLog: [],
    warnings: [],
    errors: [],
    running: false,
    monitorTimer: null,
    lastNoticeFingerprint: ''
  };

  function save(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function stamp() {
    return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  }

  function safeStorage() {
    return createPersistentStorageAdapter(globalThis);
  }

  const host = document.createElement('div');
  host.id = ID;
  Object.assign(host.style, {
    position: 'fixed',
    right: '12px',
    bottom: '18px',
    zIndex: '2147483647',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
  });
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .open{border:0;border-radius:24px;padding:12px 16px;background:#00aeec;color:#fff;font-weight:700;font-size:14px;box-shadow:0 5px 18px #0005}
      .panel{display:none;width:min(410px,calc(100vw - 24px));max-height:82vh;overflow:auto;background:#18191c;color:#eee;border-radius:14px;padding:14px;box-shadow:0 8px 30px #0008}
      .panel.show{display:block}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
      button,.file{border:0;border-radius:8px;padding:10px;background:#00aeec;color:#fff;font-weight:600;text-align:center;font-size:13px}
      button.gray,.file.gray{background:#61666d}button.red{background:#d63c5e}button:disabled{opacity:.45}
      input.import{display:none}pre{white-space:pre-wrap;word-break:break-word;background:#0f0f10;border-radius:8px;padding:10px;max-height:280px;overflow:auto;font-size:12px}
      h3{margin:0 0 8px}.small{font-size:11px;color:#aaa;margin-top:8px;line-height:1.5}
      .monitorLine{display:flex;align-items:center;gap:7px;margin-top:10px;font-size:12px}.monitorLine select{margin-left:auto;background:#303136;color:#fff;border:1px solid #61666d;border-radius:6px;padding:5px}
    </style>
    <button class="open">粉丝快照测试</button>
    <section class="panel">
      <h3>B站粉丝快照测试版</h3>
      <pre class="status">尚未读取。</pre>
      <div class="row">
        <button class="read">读取当前快照</button>
        <button class="save" disabled>保存当前 JSON</button>
        <label class="file gray">导入完整旧快照比较<input class="import" type="file" accept=".json,application/json"></label>
        <button class="saveDiff gray" disabled>保存比较/待处理 JSON</button>
        <button class="ackDiff gray" disabled>标记变化已处理</button>
        <button class="close red">关闭面板</button>
      </div>
      <label class="monitorLine">
        <input class="monitor" type="checkbox">
        页面保持打开时定时监测
        <select class="monitorInterval" aria-label="监测间隔">
          <option value="300000" selected>每 5 分钟</option>
          <option value="900000">每 15 分钟</option>
          <option value="1800000">每 30 分钟</option>
        </select>
      </label>
      <div class="small">
        只执行 GET 请求，不导出凭据。定时监测默认关闭，仅在此页面保持打开时运行；关闭页面或浏览器后即停止，不是浏览器关闭后的后台任务。关系消失仍可能是取关、注销、封禁、拉黑、平台清理或被移除。
      </div>
    </section>`;
  document.body.appendChild(host);

  const q = selector => root.querySelector(selector);
  const panel = q('.panel');
  const status = q('.status');
  const controls = {
    saveCurrent: q('.save'),
    saveDiff: q('.saveDiff'),
    ackDiff: q('.ackDiff')
  };
  q('.open').onclick = () => panel.classList.toggle('show');
  q('.close').onclick = () => panel.classList.remove('show');

  function show(text) {
    status.textContent = text;
  }

  async function api(url, label) {
    return requestJson(url, label, {
      requestLog: state.requestLog,
      onRetry({ attempt, delayMs, error }) {
        show(
          `${label} 第 ${attempt} 次失败，${delayMs}ms 后重试。\n` +
          `${error?.message || error}`
        );
      }
    });
  }

  async function getLoginInfo() {
    const json = await api(
      'https://api.bilibili.com/x/web-interface/nav',
      '确认登录账号'
    );
    return {
      isLogin: Boolean(json?.data?.isLogin),
      uid: uidOf(json?.data?.mid),
      name: String(json?.data?.uname || '')
    };
  }

  async function getRelationStat(uid, label) {
    const json = await api(
      `https://api.bilibili.com/x/relation/stat?vmid=${encodeURIComponent(uid)}`,
      label
    );
    const follower = parseCanonicalNonNegativeInteger(json?.data?.follower);
    if (follower === null) {
      throw new Error(`${label}没有有效 follower 总数。`);
    }
    return {
      follower,
      following: Number(json?.data?.following ?? 0),
      whisper: Number(json?.data?.whisper ?? 0),
      black: Number(json?.data?.black ?? 0)
    };
  }

  async function fetchFollowerPage({ uid, page, pageSize, endpoint }) {
    const json = await api(
      endpoint.buildUrl(uid, page, pageSize),
      `读取 ${endpoint.name} 第 ${page} 页`
    );
    if (!json?.data || !Array.isArray(json.data.list)) {
      throw new Error(`${endpoint.name} 第 ${page} 页响应缺少 data.list。`);
    }
    const total = parseCanonicalNonNegativeInteger(json.data.total);
    return {
      endpoint: endpoint.name,
      list: json.data.list,
      total
    };
  }

  function markNoticeOnce(uid, fingerprint, storage) {
    const key = `${LAST_NOTICE_PREFIX}${uid}`;
    if (state.lastNoticeFingerprint === fingerprint) return false;
    try {
      if (storage?.getItem(key) === fingerprint) {
        state.lastNoticeFingerprint = fingerprint;
        return false;
      }
    } catch {
      // Session de-duplication below still works when origin storage is blocked.
    }

    state.lastNoticeFingerprint = fingerprint;
    try {
      storage?.setItem(key, fingerprint);
    } catch {
      // A storage failure must not repeat the same prompt in this page session.
    }
    return true;
  }

  function restorePendingArtifact(envelope, announce = false) {
    const pending = normalizePendingChange(envelope);
    state.pendingChange = pending;
    state.comparison = pending.lastDetectedComparison;
    controls.saveDiff.disabled = false;
    controls.ackDiff.disabled = false;
    if (announce) {
      show(
        `已恢复 UID ${pending.targetUid} 的未处理变化：` +
        `${pending.comparisons.length} 份比较记录。\n` +
        '可保存比较 JSON，确认处理后再清除 pendingChange。'
      );
    }
    return pending;
  }

  function notifyMonitorChange(comparison) {
    const message =
      `定时监测发现名单变化：关系已消失 ${comparison.removedCount}，` +
      `新增 ${comparison.addedCount}。`;
    panel.classList.add('show');
    if (
      typeof Notification === 'function' &&
      Notification.permission === 'granted'
    ) {
      new Notification('B站粉丝快照监测', { body: message });
    }
    return message;
  }

  async function runScan({ automatic = false } = {}) {
    if (state.running) return null;
    state.running = true;
    const pendingBeforeScan = state.pendingChange;
    invalidateForNewScan(state, controls);
    if (pendingBeforeScan) restorePendingArtifact(pendingBeforeScan);
    q('.read').disabled = true;
    window.__BILI_FOLLOWER_MOBILE_SNAPSHOT__ = null;
    const startedAt = Date.now();
    let finalStat = null;

    try {
      show(automatic ? '定时监测：正在确认登录账号……' : '正在确认登录账号……');
      const login = await getLoginInfo();
      if (!login.isLogin || !login.uid) throw new Error('当前浏览器未登录 B站。');

      const storage = safeStorage();
      if (
        state.pendingChange &&
        state.pendingChange.targetUid !== login.uid
      ) {
        state.pendingChange = null;
        clearComparison(state, controls);
      }
      const previousStored = readLastComplete(login.uid, storage);
      if (previousStored.error && previousStored.error !== '存储不可用') {
        state.warnings.push(`读取 lastComplete 失败：${previousStored.error}`);
      }
      const previousPending = readPendingChange(login.uid, storage);
      if (previousPending.envelope) {
        restorePendingArtifact(previousPending.envelope);
      } else if (previousPending.error && previousPending.error !== '存储不可用') {
        state.warnings.push(`恢复 pendingChange 失败：${previousPending.error}`);
      }

      show(`账号：${login.name}\nUID：${login.uid}\n正在读取扫描前粉丝总数……`);
      const initialStat = await getRelationStat(login.uid, '读取扫描前粉丝总数');
      const initialTotal = initialStat.follower;

      const scan = await scanFollowersWithFailover({
        uid: login.uid,
        initialTotal,
        verifiedTotal: initialTotal,
        endpoints: CONFIG.endpointCandidates,
        fetchPage: fetchFollowerPage,
        onProgress({ endpoint, page, uniqueCount }) {
          show(
            `账号：${login.name}\nUID：${login.uid}\n扫描前总数：${initialTotal}\n` +
            `锁定接口：${endpoint}\n正在读取第 ${page} 页\n本轮唯一 UID：${uniqueCount}`
          );
        }
      });

      try {
        finalStat = await getRelationStat(login.uid, '读取扫描后粉丝总数');
      } catch (error) {
        state.warnings.push(`扫描后粉丝总数读取失败：${error.message}`);
      }

      const finalTotal = finalStat?.follower ?? null;
      const integrity = evaluateSnapshotIntegrity({
        initialTotal,
        finalTotal,
        listEndpointReportedTotals: scan.listEndpointReportedTotals,
        listEndpointTotalsStable: scan.listEndpointTotalsStable,
        uniqueTotal: scan.followers.length
      });
      const {
        statStable,
        followerDelta,
        unifiedReportedTotal,
        reportedTotalForCoverage,
        listEndpointTotalsStable,
        listTotalsAgreeWithStat,
        uniqueCoverage,
        overCoverage,
        underCoverage,
        complete
      } = integrity;
      const serviceDetailLimitLikelyReached =
        reportedTotalForCoverage > CONFIG.knownFollowerDetailLimit &&
        scan.followers.length >= CONFIG.knownFollowerDetailLimit &&
        underCoverage;

      if (!statStable) {
        state.warnings.push(
          finalTotal === null
            ? '扫描前后总数稳定性未知，因此完整性为 false。'
            : `扫描期间粉丝总数净变化 ${followerDelta >= 0 ? '+' : ''}${followerDelta}，因此完整性为 false。`
        );
      }
      if (!listEndpointTotalsStable) {
        state.warnings.push('分页响应报告的总数不稳定，因此完整性为 false。');
      }
      if (!listTotalsAgreeWithStat) {
        state.warnings.push('分页报告总数与扫描前后 stat 不一致，因此完整性为 false。');
      }
      if (underCoverage) {
        state.warnings.push(
          `唯一 UID ${scan.followers.length} 少于统一报告总数 ${unifiedReportedTotal}。`
        );
      }
      if (overCoverage) {
        state.warnings.push(
          `唯一 UID ${scan.followers.length} 超过统一报告总数 ${unifiedReportedTotal}，证据互相矛盾。`
        );
      }
      if (scan.allEndpointRoundsIncomplete) {
        state.warnings.push('所有候选接口整轮结果均未精确覆盖可验证总数；仅保留证据最接近的一轮。');
      }
      if (serviceDetailLimitLikelyReached) {
        state.warnings.push(
          `已触及已知的 ${CONFIG.knownFollowerDetailLimit} 人明细限制；更后的账号明细未得到。`
        );
      }

      const report = {
        reportType: 'bilibili-current-follower-snapshot',
        reportVersion: 'mobile-test-0.2.0',
        generatedAt: new Date().toISOString(),
        generatedAtLocal: new Date().toString(),
        targetUid: login.uid,
        targetName: login.name,
        initialStat,
        finalStat,
        initialReportedTotal: initialTotal,
        finalReportedTotal: finalTotal,
        listEndpointReportedTotals: scan.listEndpointReportedTotals,
        reportedTotalForCoverage,
        exportedUniqueTotal: scan.followers.length,
        complete,
        integrity: {
          scanWindowCountStable: statStable,
          unifiedReportedTotal,
          listEndpointTotalsStable,
          listTotalsAgreeWithStat,
          exactUniqueTotal: uniqueCoverage,
          uniqueCoverage,
          overCoverage,
          underCoverage,
          singleEndpointRound: true,
          criteria:
            'complete 仅在扫描前后 follower 总数、所有分页报告总数完全一致，且唯一 UID 数精确等于该统一总数时为 true。',
          caveat:
            '扫描前后总数相同只能证明净数量稳定，不能排除期间发生等量新增与消失。'
        },
        scanWindowChurn: {
          initialFollowerTotal: initialTotal,
          finalFollowerTotal: finalTotal,
          followerNetChange: followerDelta,
          countChangeDetected: followerDelta !== null && followerDelta !== 0
        },
        endpointUsed: scan.endpoint,
        endpointsUsed: [scan.endpoint],
        endpointRoundAttempts: scan.roundAttempts,
        pageSize: CONFIG.pageSize,
        stopReason: scan.stopReason,
        knownFollowerDetailLimit: CONFIG.knownFollowerDetailLimit,
        serviceDetailLimitLikelyReached,
        durationMs: Date.now() - startedAt,
        warnings: state.warnings,
        errors: state.errors,
        privacy: '仅执行 GET；不包含 Cookie、SESSDATA、bili_jct、access_key、密码或验证码',
        interpretation: '这是生成时刻的当前粉丝快照，不是历史取关日志。',
        followers: scan.followers,
        requestLog: [...state.requestLog]
      };

      // Set the exportable in-memory report before touching persistent storage.
      // A quota or storage failure therefore never removes manual export.
      state.current = report;
      controls.saveCurrent.disabled = false;
      window.__BILI_FOLLOWER_MOBILE_SNAPSHOT__ = report;

      let monitorMessage = '';
      let pendingPersistence = null;
      let baselinePersistence = null;
      let detectedChange = false;
      if (automatic && complete && previousStored.report) {
        try {
          const comparison = compareCompleteSnapshots(
            previousStored.report,
            report,
            'persistent:lastComplete'
          );
          if (comparison.removedCount || comparison.addedCount) {
            detectedChange = true;
            // The comparison artifact becomes available regardless of whether a
            // later notification is de-duplicated.
            state.comparison = comparison;
            controls.saveDiff.disabled = false;
            const fingerprint = changeFingerprint(comparison);
            const transaction = persistDetectedChangeBeforeBaseline(
              comparison,
              report,
              storage,
              state.pendingChange
            );
            pendingPersistence = transaction.pending;
            baselinePersistence = transaction.baseline;
            if (pendingPersistence.saved) {
              restorePendingArtifact(pendingPersistence.envelope);
            }

            if (!pendingPersistence.saved) {
              monitorMessage =
                '检测到变化，但 pendingChange 存储失败；lastComplete 未推进，' +
                '本页仍保留可导出的比较结果。';
              state.warnings.push(
                `pendingChange 存储失败：${pendingPersistence.error}`
              );
            } else if (!baselinePersistence.saved) {
              monitorMessage =
                '变化已持久保存为 pendingChange，但 lastComplete 推进失败；' +
                '下轮将从原基线重新核对。';
              state.warnings.push(
                `pendingChange 已保存，但 lastComplete 存储失败：${baselinePersistence.error}`
              );
            } else if (markNoticeOnce(login.uid, fingerprint, storage)) {
              monitorMessage = notifyMonitorChange(comparison);
            } else {
              monitorMessage =
                '变化比较已持久保存；同一通知已提示过，本次仅去重通知。';
            }
          } else {
            monitorMessage = state.pendingChange
              ? '定时监测完成：本轮名单未发生变化；既有 pendingChange 仍待处理。'
              : '定时监测完成：完整名单未发生变化。';
          }
        } catch (error) {
          if (detectedChange && !baselinePersistence) {
            baselinePersistence = {
              attempted: false,
              saved: false,
              error: '变化处理链发生异常，lastComplete 未推进'
            };
          }
          state.warnings.push(`定时比较未生成：${error.message}`);
        }
      } else if (automatic && complete) {
        monitorMessage = '定时监测完成：已建立首份完整 lastComplete 基线。';
      } else if (automatic) {
        monitorMessage = '定时监测本轮结果不完整，lastComplete 保持不变。';
      }

      const persistence = baselinePersistence || tryPersistLatestComplete(report, storage);
      report.storage = {
        latestCompleteEligible: persistence.eligible,
        latestCompleteSaveAttempted: persistence.attempted,
        latestCompleteSaved: persistence.saved,
        key: persistence.key,
        error: persistence.error,
        pendingChangeSaveAttempted: pendingPersistence?.attempted ?? false,
        pendingChangeSaved: pendingPersistence?.saved ?? false,
        pendingChangeKey: pendingPersistence?.key ?? null,
        pendingChangeError: pendingPersistence?.error ?? ''
      };
      if (
        persistence.attempted &&
        !persistence.saved &&
        !pendingPersistence
      ) {
        state.warnings.push(
          `lastComplete 存储失败：${persistence.error}。当前结果仍可手动保存 JSON。`
        );
      }

      const summary =
        `${monitorMessage ? `${monitorMessage}\n\n` : ''}` +
        `读取完成\n账号：${login.name}\nUID：${login.uid}\n` +
        `扫描前/后总数：${initialTotal} / ${finalTotal ?? '未知'}\n` +
        `净变化：${followerDelta === null ? '未知' : `${followerDelta >= 0 ? '+' : ''}${followerDelta}`}\n` +
        `实际唯一 UID：${scan.followers.length} / 统一报告总数 ${unifiedReportedTotal ?? '不一致'}\n` +
        `完整：${complete}\n锁定接口：${scan.endpoint}\n停止原因：${scan.stopReason}` +
        (state.warnings.length ? `\n\n注意：\n- ${state.warnings.join('\n- ')}` : '');
      show(summary);
      return report;
    } catch (error) {
      state.errors.push(String(error?.message || error));
      show(
        `${automatic ? '定时监测' : '读取'}失败：${error?.message || error}\n` +
        '本轮旧结果已失效；持久 lastComplete 未被覆盖。'
      );
      return null;
    } finally {
      state.running = false;
      q('.read').disabled = false;
    }
  }

  q('.read').onclick = () => runScan({ automatic: false });

  q('.save').onclick = () => {
    if (!state.current) return;
    save(
      `B站粉丝快照_${state.current.targetName}_UID${state.current.targetUid}_${stamp()}.json`,
      state.current
    );
  };

  q('.import').onchange = async event => {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    clearComparison(state, controls);

    try {
      if (!file) return;
      if (!state.current) {
        show('请先读取当前快照；旧比较结果已清除。');
        return;
      }

      const old = JSON.parse(await file.text());
      state.comparison = compareCompleteSnapshots(old, state.current, file.name);
      controls.saveDiff.disabled = false;

      const removedText = state.comparison.removed.length
        ? state.comparison.removed
            .map(item => `${item.name}（UID ${item.uid}）`)
            .join('\n')
        : '无';
      const addedText = state.comparison.added.length
        ? state.comparison.added
            .map(item => `${item.name}（UID ${item.uid}）`)
            .join('\n')
        : '无';
      show(
        `严格比较完成（完整同账号快照）\n` +
        `旧：${state.comparison.previousCount}；当前：${state.comparison.currentCount}\n` +
        `关系已消失候选：${state.comparison.removedCount}\n${removedText}\n\n` +
        `新增：${state.comparison.addedCount}\n${addedText}`
      );
    } catch (error) {
      clearComparison(state, controls);
      show(`比较未生成：${error.message}`);
    } finally {
      if (input) input.value = '';
    }
  };

  q('.saveDiff').onclick = () => {
    if (!state.comparison) return;
    const exportingPending =
      state.pendingChange &&
      !controls.ackDiff.disabled &&
      state.comparison === state.pendingChange.lastDetectedComparison;
    const artifact = exportingPending ? state.pendingChange : state.comparison;
    const artifactName = exportingPending ? '待处理变化' : '快照比较';
    save(
      `B站粉丝${artifactName}_UID${state.comparison.targetUid}_${stamp()}.json`,
      artifact
    );
  };

  q('.ackDiff').onclick = () => {
    if (!state.pendingChange) return;
    const result = tryClearPendingChange(
      state.pendingChange.targetUid,
      safeStorage()
    );
    if (!result.removed) {
      show(
        `pendingChange 清除失败：${result.error}。` +
        '比较结果和待处理标记均已保留。'
      );
      return;
    }
    state.pendingChange = null;
    clearComparison(state, controls);
    show('pendingChange 已标记为处理完成并从本地存储清除。');
  };

  function clearMonitorTimer() {
    if (state.monitorTimer !== null) {
      clearTimeout(state.monitorTimer);
      state.monitorTimer = null;
    }
  }

  function armMonitor() {
    clearMonitorTimer();
    if (!q('.monitor').checked) return;
    const intervalMs = Number(q('.monitorInterval').value) || CONFIG.defaultMonitorIntervalMs;
    state.monitorTimer = setTimeout(async () => {
      await runScan({ automatic: true });
      armMonitor();
    }, intervalMs);
  }

  q('.monitor').onchange = () => {
    if (q('.monitor').checked) {
      const minutes = Math.round(
        (Number(q('.monitorInterval').value) || CONFIG.defaultMonitorIntervalMs) / 60000
      );
      show(
        `定时监测已开启：每 ${minutes} 分钟检查一次。\n` +
        '仅在此页面保持打开时运行；关闭页面或浏览器后停止，不是后台任务。'
      );
      armMonitor();
    } else {
      clearMonitorTimer();
      show('定时监测已关闭。');
    }
  };
  q('.monitorInterval').onchange = armMonitor;
  window.addEventListener('pagehide', clearMonitorTimer);
  window.addEventListener('pageshow', event => {
    if (event.persisted && q('.monitor').checked && state.monitorTimer === null) {
      show('页面已从浏览器缓存恢复，定时监测计时器已重新挂载。');
      armMonitor();
    }
  });

  const startupPending = readAnyPendingChange(safeStorage());
  if (startupPending.envelope) {
    restorePendingArtifact(startupPending.envelope, true);
  }
})();
