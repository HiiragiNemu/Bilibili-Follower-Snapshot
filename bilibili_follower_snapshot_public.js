/**
 * Bilibili 当前粉丝完整导出与快照比较工具
 * 通用公开版
 *
 * 功能：
 * 1. 自动识别当前登录的 B站账号和 UID。
 * 2. 动态读取粉丝总数并自动分页，不写死 UID、人数或页数。
 * 3. 导出 JSON 与 CSV。
 * 4. 导入之前导出的 JSON，计算新增粉丝和“关系已消失”候选。
 * 5. 不导出 Cookie、SESSDATA、bili_jct、密码或验证码。
 *
 * 重要限制：
 * - 当前已知 B站粉丝明细接口最多返回前 1000 名；总粉丝数可以超过 1000，
 *   但第 1001 名之后的 UID/昵称明细无法由该接口取得。
 * - 只有扫描前、名单接口、扫描后三个总数一致，且唯一 UID 数精确等于
 *   该总数时，才会标记为完整并开放快照比较。
 * - “关系已消失”可能包括主动取关、注销、封禁、拉黑、平台清理或被移除，
 *   不能一律认定为主动取关。
 *
 * 运行位置：
 * - 登录 B站后，在 https://space.bilibili.com/ 页面打开开发者工具 Console。
 * - 粘贴完整脚本并运行。
 */

(async () => {
  'use strict';

  const CONFIG = Object.freeze({
    pageSize: 50,
    requestDelayMs: 350,
    maxRetries: 3,
    retryBaseDelayMs: 900,
    noProgressPageLimit: 2,
    fallbackPageGuard: 10000,
    knownFollowerDetailLimit: 1000,
    endpointCandidates: [
      {
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
      },
      {
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
      }
    ]
  });

  const TOOL_ID = '__bili_follower_snapshot_tool__';
  document.getElementById(TOOL_ID)?.remove();

  const state = {
    startedAt: new Date(),
    login: null,
    initialStat: null,
    finalStat: null,
    selectedEndpoint: null,
    endpointsUsed: new Set(),
    followers: [],
    report: null,
    comparison: null,
    requestLog: [],
    warnings: [],
    errors: [],
    stopReason: '',
    running: true
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function safeString(value) {
    return value == null ? '' : String(value);
  }

  function escapeHtml(value) {
    return safeString(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function csvEscape(value) {
    const text = safeString(value);
    return `"${text.replaceAll('"', '""')}"`;
  }

  function normalizeUid(value) {
    const uid = Number(value);
    return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
  }

  function formatLocalTime(timestampSeconds) {
    const timestamp = Number(timestampSeconds);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    return new Date(timestamp * 1000).toLocaleString('zh-CN', {
      hour12: false
    });
  }

  function sanitizeFilename(value) {
    return safeString(value)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function timestampForFilename() {
    return new Date()
      .toISOString()
      .replaceAll(':', '-')
      .replace(/\.\d{3}Z$/, 'Z');
  }

  function uniqueByUid(items) {
    const map = new Map();
    for (const item of items) {
      const uid = normalizeUid(item?.uid ?? item?.mid);
      if (uid && !map.has(uid)) {
        map.set(uid, { ...item, uid });
      }
    }
    return [...map.values()];
  }

  function normalizeFollower(item) {
    const uid = normalizeUid(item?.mid ?? item?.uid);
    if (!uid) return null;

    const followTimestamp = Number(item?.mtime || item?.followTimestamp || 0) || null;

    return {
      uid,
      name: safeString(item?.uname ?? item?.name),
      sign: safeString(item?.sign),
      face: safeString(item?.face),
      followTimestamp,
      followTime: followTimestamp ? formatLocalTime(followTimestamp) : '',
      followTimeIso: followTimestamp
        ? new Date(followTimestamp * 1000).toISOString()
        : '',
      attribute: item?.attribute ?? null,
      officialVerifyType:
        item?.official_verify?.type ??
        item?.officialVerifyType ??
        null,
      officialVerifyDescription:
        safeString(
          item?.official_verify?.desc ??
          item?.officialVerifyDescription
        ),
      vipType:
        item?.vip?.vipType ??
        item?.vipType ??
        null,
      vipStatus:
        item?.vip?.vipStatus ??
        item?.vipStatus ??
        null
    };
  }

  function evaluateSnapshotCompleteness({
    initialReportedTotal,
    listEndpointReportedTotal,
    finalReportedTotal,
    exportedUniqueTotal
  }) {
    const reportedTotals = [
      initialReportedTotal,
      listEndpointReportedTotal,
      finalReportedTotal
    ];
    const reportedTotalsConsistent =
      reportedTotals.every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) && reportedTotals.every((value) => value === reportedTotals[0]);
    const exportedCountValid =
      Number.isSafeInteger(exportedUniqueTotal) && exportedUniqueTotal >= 0;

    return {
      reportedTotalsConsistent,
      complete:
        reportedTotalsConsistent &&
        exportedCountValid &&
        exportedUniqueTotal === finalReportedTotal
    };
  }

  function validateSnapshotForComparison(report, label) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      throw new Error(`${label}快照不是有效的 JSON 对象。`);
    }

    const sourceField = Array.isArray(report.followers)
      ? 'followers'
      : Array.isArray(report.currentFollowers)
        ? 'currentFollowers'
        : null;

    if (!sourceField) {
      throw new Error(`${label}快照中没有 followers 数组。`);
    }

    if (report.complete !== true) {
      const actual = report.exportedUniqueTotal ?? report[sourceField].length;
      const reported = report.finalReportedTotal ?? '未知';
      throw new Error(
        `${label}快照不完整（实际 ${actual} / 报告 ${reported}），` +
        '已停止比较，避免把未返回的粉丝误判为关系消失。'
      );
    }

    const targetUid = normalizeUid(report.targetUid);
    if (!targetUid) {
      throw new Error(`${label}快照缺少有效的 targetUid。`);
    }

    const rawList = report[sourceField];
    const normalizedItems = rawList.map(normalizeFollower);

    if (normalizedItems.some((item) => !item)) {
      throw new Error(`${label}快照包含无效的粉丝 UID。`);
    }

    const followers = uniqueByUid(normalizedItems);
    if (followers.length !== rawList.length) {
      throw new Error(
        `${label}快照的粉丝 UID 存在重复：数组 ${rawList.length} 项，` +
        `唯一 UID ${followers.length} 个。`
      );
    }

    const requiredCountFields = [
      sourceField === 'currentFollowers'
        ? 'currentFollowerCount'
        : 'exportedUniqueTotal',
      'finalReportedTotal'
    ];
    const optionalCountFields = [
      'initialReportedTotal',
      'listEndpointReportedTotal',
      'reportedTotalForCoverage'
    ];

    for (const field of requiredCountFields) {
      const value = report[field];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label}快照缺少有效的 ${field}。`);
      }
      if (value !== followers.length) {
        throw new Error(
          `${label}快照计数不一致：${field}=${value}，` +
          `唯一 UID=${followers.length}。`
        );
      }
    }

    for (const field of optionalCountFields) {
      if (report[field] == null) continue;
      const value = report[field];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label}快照的 ${field} 不是有效计数。`);
      }
      if (value !== followers.length) {
        throw new Error(
          `${label}快照计数不一致：${field}=${value}，` +
          `唯一 UID=${followers.length}。`
        );
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(
        report,
        'listEndpointReportedTotals'
      )
    ) {
      const values = report.listEndpointReportedTotals;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(
          `${label}快照的 listEndpointReportedTotals 不是非空数组。`
        );
      }
      for (const [index, value] of values.entries()) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(
            `${label}快照的 listEndpointReportedTotals[${index}] ` +
            '不是有效计数。'
          );
        }
        if (value !== followers.length) {
          throw new Error(
            `${label}快照计数不一致：` +
            `listEndpointReportedTotals[${index}]=${value}，` +
            `唯一 UID=${followers.length}。`
          );
        }
      }
    }

    if (report.integrity != null) {
      if (
        typeof report.integrity !== 'object' ||
        Array.isArray(report.integrity)
      ) {
        throw new Error(`${label}快照的 integrity 不是有效对象。`);
      }
      const integrityCountFields = [
        'unifiedReportedTotal'
      ];
      for (const field of integrityCountFields) {
        if (report.integrity[field] == null) continue;
        const value = report.integrity[field];
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(`${label}快照的 integrity.${field} 不是有效计数。`);
        }
        if (value !== followers.length) {
          throw new Error(
            `${label}快照计数不一致：integrity.${field}=${value}，` +
            `唯一 UID=${followers.length}。`
          );
        }
      }
      const requiredTrueWhenPresent = [
        'scanWindowCountStable',
        'listEndpointTotalsStable',
        'listTotalsAgreeWithStat',
        'exactUniqueTotal',
        'uniqueCoverage'
      ];
      for (const field of requiredTrueWhenPresent) {
        if (
          Object.prototype.hasOwnProperty.call(report.integrity, field) &&
          report.integrity[field] !== true
        ) {
          throw new Error(
            `${label}快照的 integrity.${field} 未通过完整性校验。`
          );
        }
      }
      if (report.integrity.overCoverage === true) {
        throw new Error(`${label}快照声明存在 overCoverage。`);
      }
      if (report.integrity.underCoverage === true) {
        throw new Error(`${label}快照声明存在 underCoverage。`);
      }
    }

    return {
      targetUid,
      followers,
      reportedTotal: report.finalReportedTotal,
      exportedUniqueTotal:
        report[
          sourceField === 'currentFollowers'
            ? 'currentFollowerCount'
            : 'exportedUniqueTotal'
        ]
    };
  }

  async function fetchJson(url, label, attempt = 1) {
    const started = performance.now();

    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json, text/plain, */*'
        }
      });

      const text = await response.text();
      let json;

      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(
          `返回内容不是 JSON：HTTP ${response.status}，${text.slice(0, 180)}`
        );
      }

      state.requestLog.push({
        label,
        url,
        attempt,
        httpStatus: response.status,
        apiCode: json?.code ?? null,
        apiMessage: json?.message ?? json?.msg ?? '',
        elapsedMs: Math.round(performance.now() - started)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (typeof json?.code === 'number' && json.code !== 0) {
        throw new Error(
          `B站接口 code=${json.code}，message=${json.message || json.msg || ''}`
        );
      }

      return json;
    } catch (error) {
      if (attempt < CONFIG.maxRetries) {
        const delay =
          CONFIG.retryBaseDelayMs *
          Math.pow(2, attempt - 1);

        log(
          `${label} 第 ${attempt} 次失败，${delay}ms 后重试：${error.message}`,
          'warn'
        );

        await sleep(delay);
        return fetchJson(url, label, attempt + 1);
      }

      throw error;
    }
  }

  async function getLoginInfo() {
    const json = await fetchJson(
      'https://api.bilibili.com/x/web-interface/nav',
      '读取登录账号'
    );

    return {
      isLogin: Boolean(json?.data?.isLogin),
      uid: normalizeUid(json?.data?.mid),
      name: safeString(json?.data?.uname)
    };
  }

  async function getRelationStat(uid) {
    const json = await fetchJson(
      `https://api.bilibili.com/x/relation/stat?vmid=${encodeURIComponent(uid)}`,
      '读取粉丝总数'
    );

    return {
      follower: Number(json?.data?.follower ?? 0),
      following: Number(json?.data?.following ?? 0),
      whisper: Number(json?.data?.whisper ?? 0),
      black: Number(json?.data?.black ?? 0)
    };
  }

  async function getFollowerPage(uid, page) {
    const orderedEndpoints = state.selectedEndpoint
      ? [
          state.selectedEndpoint,
          ...CONFIG.endpointCandidates.filter(
            (item) => item.name !== state.selectedEndpoint.name
          )
        ]
      : [...CONFIG.endpointCandidates];

    const failures = [];

    for (const endpoint of orderedEndpoints) {
      const url = endpoint.buildUrl(uid, page, CONFIG.pageSize);

      try {
        const json = await fetchJson(
          url,
          `读取粉丝第 ${page} 页（${endpoint.name}）`
        );

        const list = Array.isArray(json?.data?.list)
          ? json.data.list
          : [];

        state.selectedEndpoint = endpoint;
        state.endpointsUsed.add(endpoint.name);

        return {
          endpoint: endpoint.name,
          list,
          total:
            Number.isFinite(Number(json?.data?.total))
              ? Number(json.data.total)
              : null,
          rawDataKeys:
            json?.data && typeof json.data === 'object'
              ? Object.keys(json.data)
              : []
        };
      } catch (error) {
        failures.push(`${endpoint.name}: ${error.message}`);
      }
    }

    throw new Error(failures.join('；'));
  }

  function createPanel() {
    const host = document.createElement('div');
    host.id = TOOL_ID;
    host.style.position = 'fixed';
    host.style.top = '18px';
    host.style.right = '18px';
    host.style.zIndex = '2147483647';

    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>
        :host {
          all: initial;
        }

        .panel {
          width: min(430px, calc(100vw - 36px));
          max-height: calc(100vh - 36px);
          overflow: auto;
          box-sizing: border-box;
          padding: 18px;
          border: 1px solid rgba(255, 255, 255, .18);
          border-radius: 14px;
          background: rgba(24, 25, 28, .97);
          color: #f1f2f3;
          box-shadow: 0 12px 36px rgba(0, 0, 0, .42);
          font-family:
            -apple-system, BlinkMacSystemFont, "Segoe UI",
            "Microsoft YaHei", sans-serif;
          font-size: 14px;
          line-height: 1.55;
        }

        h2 {
          margin: 0 0 10px;
          font-size: 18px;
          font-weight: 700;
        }

        .summary {
          margin: 10px 0;
          padding: 10px 12px;
          border-radius: 9px;
          background: rgba(255, 255, 255, .07);
          white-space: pre-wrap;
          word-break: break-word;
        }

        .status {
          margin: 10px 0;
          color: #00aeec;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .warning {
          color: #ffb027;
        }

        .error {
          color: #ff6699;
        }

        .success {
          color: #2ac864;
        }

        .actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-top: 12px;
        }

        button,
        .file-label {
          box-sizing: border-box;
          min-height: 38px;
          padding: 8px 10px;
          border: 0;
          border-radius: 8px;
          color: #fff;
          background: #00aeec;
          font: inherit;
          font-weight: 600;
          text-align: center;
          cursor: pointer;
        }

        button.secondary,
        .file-label.secondary {
          background: #61666d;
        }

        button.danger {
          background: #d63c5e;
        }

        button:disabled,
        .file-label.disabled {
          opacity: .45;
          cursor: not-allowed;
        }

        input[type="file"] {
          display: none;
        }

        details {
          margin-top: 12px;
        }

        pre {
          overflow: auto;
          max-height: 240px;
          padding: 9px;
          border-radius: 7px;
          background: #111;
          color: #ddd;
          white-space: pre-wrap;
          word-break: break-word;
          font: 12px/1.45 Consolas, monospace;
        }

        .small {
          margin-top: 10px;
          color: #aaa;
          font-size: 12px;
        }
      </style>

      <section class="panel">
        <h2>B站粉丝快照工具</h2>

        <div id="summary" class="summary">正在初始化……</div>
        <div id="status" class="status">等待读取账号。</div>

        <div class="actions">
          <button id="saveJson" disabled>保存 JSON</button>
          <button id="saveCsv" disabled>保存 CSV</button>

          <label
            id="loadBaselineLabel"
            class="file-label secondary disabled"
            for="loadBaseline"
          >
            导入旧快照
          </label>
          <input
            id="loadBaseline"
            type="file"
            accept=".json,application/json"
            disabled
          >

          <button id="saveCompareJson" class="secondary" disabled>
            保存比较 JSON
          </button>
          <button id="saveCompareCsv" class="secondary" disabled>
            保存比较 CSV
          </button>

          <button id="close" class="danger">
            关闭面板
          </button>
        </div>

        <details>
          <summary>日志与限制说明</summary>
          <pre id="log"></pre>
        </details>

        <div class="small">
          本工具只导出粉丝公开资料与关注时间，不导出登录凭据。
          “关系已消失”不必然等于主动取关。
        </div>
      </section>
    `;

    document.body.appendChild(host);

    const elements = {
      host,
      root,
      summary: root.getElementById('summary'),
      status: root.getElementById('status'),
      log: root.getElementById('log'),
      saveJson: root.getElementById('saveJson'),
      saveCsv: root.getElementById('saveCsv'),
      loadBaseline: root.getElementById('loadBaseline'),
      loadBaselineLabel: root.getElementById('loadBaselineLabel'),
      saveCompareJson: root.getElementById('saveCompareJson'),
      saveCompareCsv: root.getElementById('saveCompareCsv'),
      close: root.getElementById('close')
    };

    elements.close.addEventListener('click', () => host.remove());

    return elements;
  }

  const ui = createPanel();

  function log(message, level = 'info') {
    const line =
      `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ` +
      `${message}`;

    console[
      level === 'error'
        ? 'error'
        : level === 'warn'
          ? 'warn'
          : 'log'
    ](`[B站粉丝快照] ${message}`);

    ui.log.textContent += `${line}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function setStatus(message, type = 'normal') {
    ui.status.textContent = message;
    ui.status.className =
      type === 'error'
        ? 'status error'
        : type === 'warning'
          ? 'status warning'
          : type === 'success'
            ? 'status success'
            : 'status';
  }

  function updateSummary() {
    const login = state.login;
    const report = state.report;

    if (!login) {
      ui.summary.textContent = '尚未识别登录账号。';
      return;
    }

    const lines = [
      `账号：${login.name || '未知昵称'}`,
      `UID：${login.uid || '未知'}`,
      `接口报告粉丝数：${
        report?.finalReportedTotal ??
        state.initialStat?.follower ??
        '读取中'
      }`,
      `实际取得唯一 UID：${report?.exportedUniqueTotal ?? state.followers.length}`,
      `已知明细上限：${CONFIG.knownFollowerDetailLimit} 人`,
      `完整性：${
        report
          ? report.complete
            ? '完整'
            : '不完整'
          : '读取中'
      }`
    ];

    if (report?.stopReason) {
      lines.push(`停止原因：${report.stopReason}`);
    }

    ui.summary.textContent = lines.join('\n');
  }

  async function saveTextFile({
    suggestedName,
    text,
    mimeType,
    extension,
    description
  }) {
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [
            {
              description,
              accept: {
                [mimeType]: [extension]
              }
            }
          ]
        });

        const writable = await handle.createWritable();
        await writable.write(
          new Blob([text], { type: `${mimeType};charset=utf-8` })
        );
        await writable.close();
        return { method: 'showSaveFilePicker' };
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }

        log(
          `系统保存窗口不可用，改用浏览器下载：${error.message}`,
          'warn'
        );
      }
    }

    const blob = new Blob([text], {
      type: `${mimeType};charset=utf-8`
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = objectUrl;
    anchor.download = suggestedName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);

    return { method: 'download-attribute' };
  }

  function followersToCsv(report) {
    const headers = [
      'UID',
      '昵称',
      '签名',
      '头像地址',
      '关注时间',
      '关注时间戳',
      '官方认证类型',
      '官方认证说明',
      '大会员类型',
      '大会员状态'
    ];

    const rows = report.followers.map((item) => [
      item.uid,
      item.name,
      item.sign,
      item.face,
      item.followTime,
      item.followTimestamp ?? '',
      item.officialVerifyType ?? '',
      item.officialVerifyDescription,
      item.vipType ?? '',
      item.vipStatus ?? ''
    ]);

    return (
      '\uFEFF' +
      [headers, ...rows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\r\n')
    );
  }

  function comparisonToCsv(comparison) {
    const headers = [
      '变化类型',
      'UID',
      '旧快照昵称',
      '当前昵称',
      '旧快照关注时间',
      '当前关注时间',
      '说明'
    ];

    const removedRows = comparison.removed.map((item) => [
      '关系已消失',
      item.uid,
      item.previousName,
      '',
      item.previousFollowTime,
      '',
      '可能是取关、注销、封禁、拉黑、平台清理或被移除'
    ]);

    const addedRows = comparison.added.map((item) => [
      '新增',
      item.uid,
      '',
      item.currentName,
      '',
      item.currentFollowTime,
      '当前快照中新增出现'
    ]);

    return (
      '\uFEFF' +
      [headers, ...removedRows, ...addedRows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\r\n')
    );
  }

  function enableExportButtons() {
    ui.saveJson.disabled = !state.report;
    ui.saveCsv.disabled = !state.report;
    const comparisonInputDisabled = state.report?.complete !== true;
    ui.loadBaseline.disabled = comparisonInputDisabled;
    ui.loadBaselineLabel.classList.toggle(
      'disabled',
      comparisonInputDisabled
    );
    ui.saveCompareJson.disabled = !state.comparison;
    ui.saveCompareCsv.disabled = !state.comparison;
  }

  ui.saveJson.addEventListener('click', async () => {
    if (!state.report) return;

    const filename =
      `B站粉丝快照_${sanitizeFilename(state.report.targetName)}` +
      `_UID${state.report.targetUid}_${timestampForFilename()}.json`;

    try {
      await saveTextFile({
        suggestedName: filename,
        text: JSON.stringify(state.report, null, 2),
        mimeType: 'application/json',
        extension: '.json',
        description: 'B站粉丝快照 JSON'
      });

      setStatus(`JSON 已保存：${filename}`, 'success');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setStatus(`JSON 保存失败：${error.message}`, 'error');
      }
    }
  });

  ui.saveCsv.addEventListener('click', async () => {
    if (!state.report) return;

    const filename =
      `B站粉丝快照_${sanitizeFilename(state.report.targetName)}` +
      `_UID${state.report.targetUid}_${timestampForFilename()}.csv`;

    try {
      await saveTextFile({
        suggestedName: filename,
        text: followersToCsv(state.report),
        mimeType: 'text/csv',
        extension: '.csv',
        description: 'B站粉丝快照 CSV'
      });

      setStatus(`CSV 已保存：${filename}`, 'success');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setStatus(`CSV 保存失败：${error.message}`, 'error');
      }
    }
  });

  ui.loadBaseline.addEventListener('change', async (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    try {
      state.comparison = null;

      if (!state.report) {
        throw new Error('当前快照尚未生成，请等待读取结束后再导入旧快照。');
      }

      const currentSnapshot = validateSnapshotForComparison(
        state.report,
        '当前'
      );

      const oldReport = JSON.parse(await file.text());
      const oldSnapshot = validateSnapshotForComparison(
        oldReport,
        '旧'
      );

      if (oldSnapshot.targetUid !== currentSnapshot.targetUid) {
        throw new Error(
          `快照账号不一致：旧快照 UID ${oldSnapshot.targetUid}，` +
          `当前快照 UID ${currentSnapshot.targetUid}。`
        );
      }

      const oldNormalized = oldSnapshot.followers;
      const currentNormalized = currentSnapshot.followers;

      const oldMap = new Map(
        oldNormalized.map((item) => [item.uid, item])
      );

      const currentMap = new Map(
        currentNormalized.map((item) => [item.uid, item])
      );

      const removed = [];
      const added = [];

      for (const [uid, item] of oldMap) {
        if (!currentMap.has(uid)) {
          removed.push({
            uid,
            previousName: item.name,
            previousFollowTime: item.followTime,
            previousFollowTimestamp: item.followTimestamp
          });
        }
      }

      for (const [uid, item] of currentMap) {
        if (!oldMap.has(uid)) {
          added.push({
            uid,
            currentName: item.name,
            currentFollowTime: item.followTime,
            currentFollowTimestamp: item.followTimestamp
          });
        }
      }

      state.comparison = {
        reportType: 'bilibili-follower-snapshot-comparison',
        reportVersion: 'public-comparison-2026-08-09-v1.1',
        generatedAt: new Date().toISOString(),
        targetUid: state.report.targetUid,
        targetName: state.report.targetName,
        previousFileName: file.name,
        previousGeneratedAt: oldReport.generatedAt ?? null,
        currentGeneratedAt: state.report.generatedAt,
        previousComplete: oldReport.complete,
        currentComplete: state.report.complete,
        previousReportedTotal: oldSnapshot.reportedTotal,
        currentReportedTotal: currentSnapshot.reportedTotal,
        previousExportedUniqueTotal: oldSnapshot.exportedUniqueTotal,
        currentExportedUniqueTotal: currentSnapshot.exportedUniqueTotal,
        previousFollowerCount: oldNormalized.length,
        currentFollowerCount: currentNormalized.length,
        removedCount: removed.length,
        addedCount: added.length,
        confidence: 'high',
        validity: {
          valid: true,
          rule: 'both-complete-same-target-exact-counts',
          checks: {
            bothComplete:
              oldReport.complete === true && state.report.complete === true,
            sameTargetUid:
              oldSnapshot.targetUid === currentSnapshot.targetUid,
            previousCountsExact:
              oldNormalized.length === oldSnapshot.reportedTotal,
            currentCountsExact:
              currentNormalized.length === currentSnapshot.reportedTotal
          }
        },
        interpretation:
          'removed 表示关系已消失候选，可能包括主动取关、注销、封禁、拉黑、平台清理或被移除。',
        removed,
        added
      };

      log(
        `快照比较完成：关系已消失 ${removed.length}，新增 ${added.length}`
      );

      setStatus(
        `比较完成：\n关系已消失候选 ${removed.length} 人\n新增 ${added.length} 人`,
        removed.length ? 'warning' : 'success'
      );

      enableExportButtons();
    } catch (error) {
      state.comparison = null;
      enableExportButtons();
      setStatus(`快照比较已停止：${error.message}`, 'error');
      log(`快照比较已停止：${error.stack || error.message}`, 'error');
    } finally {
      input.value = '';
    }
  });

  ui.saveCompareJson.addEventListener('click', async () => {
    if (!state.comparison) return;

    const filename =
      `B站粉丝快照比较_${sanitizeFilename(state.comparison.targetName)}` +
      `_UID${state.comparison.targetUid}_${timestampForFilename()}.json`;

    try {
      await saveTextFile({
        suggestedName: filename,
        text: JSON.stringify(state.comparison, null, 2),
        mimeType: 'application/json',
        extension: '.json',
        description: 'B站粉丝快照比较 JSON'
      });

      setStatus(`比较 JSON 已保存：${filename}`, 'success');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setStatus(`比较 JSON 保存失败：${error.message}`, 'error');
      }
    }
  });

  ui.saveCompareCsv.addEventListener('click', async () => {
    if (!state.comparison) return;

    const filename =
      `B站粉丝快照比较_${sanitizeFilename(state.comparison.targetName)}` +
      `_UID${state.comparison.targetUid}_${timestampForFilename()}.csv`;

    try {
      await saveTextFile({
        suggestedName: filename,
        text: comparisonToCsv(state.comparison),
        mimeType: 'text/csv',
        extension: '.csv',
        description: 'B站粉丝快照比较 CSV'
      });

      setStatus(`比较 CSV 已保存：${filename}`, 'success');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setStatus(`比较 CSV 保存失败：${error.message}`, 'error');
      }
    }
  });

  async function run() {
    try {
      setStatus('正在确认登录账号……');
      state.login = await getLoginInfo();

      if (!state.login.isLogin || !state.login.uid) {
        throw new Error('当前浏览器未登录 B站。');
      }

      log(
        `登录账号：${state.login.name}，UID ${state.login.uid}`
      );

      updateSummary();

      setStatus('正在读取粉丝总数……');
      state.initialStat = await getRelationStat(state.login.uid);

      const initialTotal = state.initialStat.follower;
      log(`初始粉丝总数：${initialTotal}`);

      updateSummary();

      const followersMap = new Map();
      let page = 1;
      let noProgressPages = 0;
      let listEndpointReportedTotal = null;

      const expectedPages =
        Number.isFinite(initialTotal) && initialTotal > 0
          ? Math.ceil(initialTotal / CONFIG.pageSize) + 2
          : CONFIG.fallbackPageGuard;

      while (page <= expectedPages) {
        setStatus(
          `正在读取第 ${page} 页……\n` +
          `当前已取得 ${followersMap.size}` +
          (
            Number.isFinite(initialTotal)
              ? ` / 初始总数 ${initialTotal}`
              : ''
          )
        );

        const result = await getFollowerPage(
          state.login.uid,
          page
        );

        if (
          Number.isFinite(result.total) &&
          result.total >= 0
        ) {
          listEndpointReportedTotal = result.total;
        }

        const before = followersMap.size;

        for (const rawItem of result.list) {
          const item = normalizeFollower(rawItem);
          if (item && !followersMap.has(item.uid)) {
            followersMap.set(item.uid, item);
          }
        }

        const addedThisPage = followersMap.size - before;

        log(
          `第 ${page} 页：接口 ${result.endpoint}，` +
          `返回 ${result.list.length}，新增唯一 UID ${addedThisPage}，` +
          `累计 ${followersMap.size}`
        );

        if (result.list.length === 0) {
          state.stopReason = `第 ${page} 页返回空列表`;
          break;
        }

        if (addedThisPage === 0) {
          noProgressPages += 1;
        } else {
          noProgressPages = 0;
        }

        if (noProgressPages >= CONFIG.noProgressPageLimit) {
          state.stopReason =
            `连续 ${noProgressPages} 页没有新增 UID，接口可能开始重复数据`;
          break;
        }

        const targetAtThisMoment = Math.max(
          initialTotal || 0,
          listEndpointReportedTotal || 0
        );

        if (
          targetAtThisMoment > 0 &&
          followersMap.size >= targetAtThisMoment
        ) {
          state.stopReason = '已达到接口报告的粉丝总数';
          break;
        }

        if (result.list.length < CONFIG.pageSize) {
          state.stopReason =
            `第 ${page} 页不足 ${CONFIG.pageSize} 条，已到接口末页`;
          break;
        }

        page += 1;
        await sleep(CONFIG.requestDelayMs);
      }

      if (!state.stopReason && page > expectedPages) {
        state.stopReason =
          `达到动态计算的安全页数 ${expectedPages}`;
      }

      state.followers = [...followersMap.values()].sort(
        (a, b) =>
          (b.followTimestamp || 0) -
          (a.followTimestamp || 0)
      );

      try {
        state.finalStat = await getRelationStat(state.login.uid);
      } catch (error) {
        state.warnings.push(
          `结束时粉丝总数读取失败：${error.message}`
        );
      }

      const finalStatReportedTotal = state.finalStat?.follower ?? null;
      const finalReportedTotal =
        finalStatReportedTotal ??
        listEndpointReportedTotal ??
        initialTotal ??
        null;

      const completeness = evaluateSnapshotCompleteness({
        initialReportedTotal: initialTotal,
        listEndpointReportedTotal,
        finalReportedTotal: finalStatReportedTotal,
        exportedUniqueTotal: state.followers.length
      });
      const { complete, reportedTotalsConsistent } = completeness;

      const serviceDetailLimitLikelyReached =
        Number.isFinite(finalReportedTotal) &&
        finalReportedTotal > CONFIG.knownFollowerDetailLimit &&
        state.followers.length >= CONFIG.knownFollowerDetailLimit &&
        state.followers.length < finalReportedTotal;

      if (!reportedTotalsConsistent) {
        state.warnings.push(
          '扫描前总数、名单接口总数和扫描后总数不一致，因此本次快照不具备比较资格。'
        );
      }

      if (serviceDetailLimitLikelyReached) {
        state.warnings.push(
          `接口报告共有 ${finalReportedTotal} 名粉丝，但当前已知粉丝明细接口最多返回前 ${CONFIG.knownFollowerDetailLimit} 名。第 ${CONFIG.knownFollowerDetailLimit + 1} 名之后的 UID、昵称和关注时间无法通过该接口导出。`
        );
      } else if (!complete) {
        state.warnings.push(
          '实际取得人数少于接口报告总数。可能原因包括服务端展示上限、风控、权限限制、接口变化或导出期间关系发生变化。'
        );
      }

      state.report = {
        reportType: 'bilibili-current-follower-snapshot',
        reportVersion: 'public-2026-08-09-v1.2',
        generatedAt: new Date().toISOString(),
        generatedAtLocal: new Date().toString(),
        targetUid: state.login.uid,
        targetName: state.login.name,
        initialReportedTotal: initialTotal,
        listEndpointReportedTotal,
        finalReportedTotal,
        knownFollowerDetailLimit: CONFIG.knownFollowerDetailLimit,
        serviceDetailLimitLikelyReached,
        exportedUniqueTotal: state.followers.length,
        reportedTotalsConsistent,
        complete,
        pageSize: CONFIG.pageSize,
        endpointUsed: state.selectedEndpoint?.name ?? null,
        endpointsUsed: [...state.endpointsUsed],
        stopReason: state.stopReason,
        durationMs:
          Date.now() - state.startedAt.getTime(),
        warnings: state.warnings,
        errors: state.errors,
        privacy:
          '不包含 Cookie、SESSDATA、bili_jct、密码或验证码',
        interpretation:
          '该文件是生成时刻的当前粉丝快照，不是历史取关日志。',
        followers: state.followers,
        requestLog: state.requestLog
      };

      state.running = false;

      window.__BILI_FOLLOWER_SNAPSHOT__ = state.report;

      updateSummary();
      enableExportButtons();

      if (complete) {
        setStatus(
          `读取完成：${state.followers.length} 人。\n` +
          '结果通过总数完整性校验，可以保存。',
          'success'
        );
      } else if (serviceDetailLimitLikelyReached) {
        setStatus(
          `读取结束：接口总数 ${finalReportedTotal}，` +
          `仅取得前 ${state.followers.length} 人。\n` +
          `B站当前粉丝明细接口的已知上限为 ${CONFIG.knownFollowerDetailLimit} 人，` +
          `第 ${CONFIG.knownFollowerDetailLimit + 1} 名之后的账号明细未包含在本次快照中，` +
          '旧快照比较已停用。',
          'warning'
        );
      } else {
        setStatus(
          `读取结束，但结果不完整：${state.followers.length}` +
          ` / ${finalReportedTotal ?? '未知总数'}。\n` +
          '仍可保存用于分析；旧快照比较已停用。',
          'warning'
        );
      }

      log(
        `完成：实际 ${state.followers.length}，` +
        `报告总数 ${finalReportedTotal}，完整=${complete}`
      );
    } catch (error) {
      state.running = false;
      state.errors.push(error.message);
      updateSummary();
      enableExportButtons();

      setStatus(`运行失败：${error.message}`, 'error');
      log(error.stack || error.message, 'error');
    }
  }

  await run();
})();
