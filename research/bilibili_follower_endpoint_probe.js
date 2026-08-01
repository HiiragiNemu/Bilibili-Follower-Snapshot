// Bilibili 粉丝接口只读探测器。仅执行 GET，不输出登录凭据。
(async () => {
  'use strict';

  const report = {
    reportType: 'bilibili-follower-endpoint-probe',
    generatedAt: new Date().toISOString(),
    account: null,
    total: null,
    tests: {},
    conclusions: [],
    privacy: '只读GET；不包含Cookie、SESSDATA、bili_jct、access_key、密码或验证码'
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function get(url) {
    try {
      const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json, text/plain, */*' }
      });
      const json = await response.json();
      return {
        ok: response.ok && (json?.code === 0 || json?.code == null),
        httpStatus: response.status,
        code: json?.code ?? null,
        message: json?.message ?? json?.msg ?? '',
        data: json?.data ?? null
      };
    } catch (e) {
      return { ok: false, error: e.message, data: null };
    }
  }

  function summary(raw) {
    const list = Array.isArray(raw?.data?.list) ? raw.data.list : [];
    return {
      ok: raw?.ok || false,
      httpStatus: raw?.httpStatus ?? null,
      code: raw?.code ?? null,
      message: raw?.message ?? raw?.error ?? '',
      total: Number.isFinite(Number(raw?.data?.total)) ? Number(raw.data.total) : null,
      listLength: list.length,
      offset: raw?.data?.offset ?? null,
      firstUid: Number(list[0]?.mid ?? list[0]?.uid) || null,
      lastUid: Number(list.at(-1)?.mid ?? list.at(-1)?.uid) || null,
      containsMtime: list.some(x => x?.mtime != null),
      containsRecommendationFields: list.some(x => x?.rec_reason || x?.track_id),
      dataKeys: raw?.data && typeof raw.data === 'object' ? Object.keys(raw.data) : []
    };
  }

  function identityArrays(value, path = 'data', depth = 0) {
    if (depth > 6 || value == null) return [];
    const hits = [];
    if (Array.isArray(value)) {
      const objects = value.filter(x => x && typeof x === 'object');
      const identities = objects.filter(x => ['mid','uid','uname','name','face','mtime'].some(k => Object.hasOwn(x, k)));
      if (identities.length) hits.push({ path, length: value.length, identityLike: identities.length, sampleKeys: Object.keys(identities[0]) });
      for (let i = 0; i < Math.min(value.length, 10); i++) hits.push(...identityArrays(value[i], `${path}[${i}]`, depth + 1));
    } else if (typeof value === 'object') {
      for (const [k,v] of Object.entries(value)) hits.push(...identityArrays(v, `${path}.${k}`, depth + 1));
    }
    return hits;
  }

  const nav = await get('https://api.bilibili.com/x/web-interface/nav');
  if (!nav.ok || !nav.data?.isLogin || !nav.data?.mid) throw new Error('当前浏览器未登录B站。');
  const uid = Number(nav.data.mid);
  report.account = { uid, name: nav.data.uname || '' };

  const stat = await get(`https://api.bilibili.com/x/relation/stat?vmid=${uid}`);
  report.total = Number(stat.data?.follower ?? 0);
  const total = report.total;
  const pageSize = 50;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  report.tests.pageBoundary = [];
  for (const endpoint of ['fans', 'followers']) {
    for (const pn of [...new Set([1, 20, 21, 22, lastPage, lastPage + 1])].sort((a,b)=>a-b)) {
      const raw = await get(`https://api.bilibili.com/x/relation/${endpoint}?vmid=${uid}&pn=${pn}&ps=${pageSize}&order=desc`);
      report.tests.pageBoundary.push({ endpoint, pn, ...summary(raw) });
      await sleep(350);
    }
  }

  report.tests.offsetChain = { pages: [], uniqueUidCount: 0, stopReason: '' };
  const seen = new Set();
  const offsets = new Set();
  let offset = '';
  for (let step = 1; step <= 30; step++) {
    const params = new URLSearchParams({ vmid: String(uid), ps: String(pageSize), order: 'desc' });
    if (offset) params.set('offset', offset); else params.set('pn', '1');
    const raw = await get(`https://api.bilibili.com/x/relation/fans?${params}`);
    const list = Array.isArray(raw.data?.list) ? raw.data.list : [];
    let added = 0;
    for (const item of list) {
      const itemUid = Number(item?.mid ?? item?.uid);
      if (itemUid && !seen.has(itemUid)) { seen.add(itemUid); added++; }
    }
    const s = summary(raw);
    report.tests.offsetChain.pages.push({ step, requestedOffset: offset || null, added, cumulative: seen.size, ...s });
    if (!raw.ok) { report.tests.offsetChain.stopReason = '接口失败'; break; }
    if (!list.length) { report.tests.offsetChain.stopReason = '空列表'; break; }
    if (!raw.data?.offset) { report.tests.offsetChain.stopReason = '无offset'; break; }
    if (offsets.has(raw.data.offset)) { report.tests.offsetChain.stopReason = 'offset重复'; break; }
    if (!added) { report.tests.offsetChain.stopReason = '无新增UID'; break; }
    offsets.add(raw.data.offset);
    offset = String(raw.data.offset);
    await sleep(350);
  }
  report.tests.offsetChain.uniqueUidCount = seen.size;

  report.tests.fromMain = [];
  for (const query of [
    `vmid=${uid}&ps=50&from=main&last_access_ts=0`,
    `vmid=${uid}&pn=1&ps=50&from=main&last_access_ts=0`
  ]) {
    report.tests.fromMain.push(summary(await get(`https://api.bilibili.com/x/relation/fans?${query}`)));
    await sleep(350);
  }

  report.tests.creatorCenter = [];
  for (const [name,url] of [
    ['num','https://member.bilibili.com/x/web/data/v2/fans/stat/num?period=2'],
    ['all_fans','https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type=all_fans&period=2'],
    ['follow','https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type=follow&period=2'],
    ['unfollow','https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type=unfollow&period=2']
  ]) {
    const raw = await get(url);
    report.tests.creatorCenter.push({ name, ok: raw.ok, code: raw.code, message: raw.message, dataKeys: raw.data && typeof raw.data === 'object' ? Object.keys(raw.data) : [], identityArrays: identityArrays(raw.data) });
    await sleep(350);
  }

  report.conclusions.push(total > 1000
    ? `总数${total}，offset取得${seen.size}个唯一UID。`
    : `当前总数${total}低于1000，不能决定性验证第1001名以后。`);
  report.conclusions.push(report.tests.creatorCenter.some(x => x.identityArrays.length)
    ? '创作中心发现疑似身份数组，需要继续解析。'
    : '创作中心未发现UID/昵称身份数组。');

  window.__BILI_FOLLOWER_ENDPOINT_PROBE__ = report;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `B站粉丝候选接口测试_UID${uid}_${new Date().toISOString().replaceAll(':','-')}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  console.log('[粉丝接口探测完成]', report);
  alert(`测试完成。总数：${total}；offset唯一UID：${seen.size}。请上传生成的JSON。`);
})();
