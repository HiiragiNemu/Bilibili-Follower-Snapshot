// ==UserScript==
// @name         B站粉丝快照测试版（手机/桌面）
// @namespace    https://github.com/HiiragiNemu/Bilibili-Follower-Snapshot
// @version      0.1.0-test
// @description  读取当前粉丝快照，导入旧JSON并比较新增与关系消失候选
// @author       HiiragiNemu
// @match        https://space.bilibili.com/*
// @match        https://www.bilibili.com/h5/follow/newFans*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/HiiragiNemu/Bilibili-Follower-Snapshot/test/mobile-endpoint-probe/userscript/bilibili-follower-mobile-test.user.js
// @updateURL    https://raw.githubusercontent.com/HiiragiNemu/Bilibili-Follower-Snapshot/test/mobile-endpoint-probe/userscript/bilibili-follower-mobile-test.user.js
// ==/UserScript==

(async () => {
  'use strict';

  const ID = '__bili_mobile_follower_test__';
  if (document.getElementById(ID)) return;

  const state = { current: null, comparison: null, running: false };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uidOf = x => {
    const n = Number(x?.uid ?? x?.mid);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };

  async function api(url) {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    const json = await response.json();
    if (!response.ok || json?.code !== 0) {
      throw new Error(`HTTP ${response.status}; code=${json?.code}; ${json?.message || ''}`);
    }
    return json;
  }

  function normalize(item) {
    const uid = uidOf(item);
    if (!uid) return null;
    const ts = Number(item.mtime ?? item.followTimestamp ?? 0) || null;
    return {
      uid,
      name: String(item.uname ?? item.name ?? ''),
      sign: String(item.sign ?? ''),
      face: String(item.face ?? ''),
      followTimestamp: ts,
      followTime: ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : ''
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

  function save(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function stamp() {
    return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  }

  const host = document.createElement('div');
  host.id = ID;
  Object.assign(host.style, {
    position: 'fixed', right: '12px', bottom: '18px', zIndex: '2147483647',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
  });
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .open{border:0;border-radius:24px;padding:12px 16px;background:#00aeec;color:#fff;font-weight:700;font-size:14px;box-shadow:0 5px 18px #0005}
      .panel{display:none;width:min(390px,calc(100vw - 24px));max-height:80vh;overflow:auto;background:#18191c;color:#eee;border-radius:14px;padding:14px;box-shadow:0 8px 30px #0008}
      .panel.show{display:block}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
      button,.file{border:0;border-radius:8px;padding:10px;background:#00aeec;color:#fff;font-weight:600;text-align:center;font-size:13px}
      button.gray,.file.gray{background:#61666d}button.red{background:#d63c5e}input{display:none}
      pre{white-space:pre-wrap;word-break:break-word;background:#0f0f10;border-radius:8px;padding:10px;max-height:250px;overflow:auto;font-size:12px}
      h3{margin:0 0 8px}.small{font-size:11px;color:#aaa;margin-top:8px}
    </style>
    <button class="open">粉丝快照测试</button>
    <section class="panel">
      <h3>B站粉丝快照测试版</h3>
      <pre class="status">尚未读取。</pre>
      <div class="row">
        <button class="read">读取当前快照</button>
        <button class="save" disabled>保存当前JSON</button>
        <label class="file gray">导入旧快照比较<input class="import" type="file" accept=".json,application/json"></label>
        <button class="saveDiff gray" disabled>保存比较JSON</button>
        <button class="close red">关闭面板</button>
      </div>
      <div class="small">只执行GET请求。关系消失可能是取关、注销、封禁、拉黑、平台清理或被移除。</div>
    </section>`;
  document.body.appendChild(host);

  const q = s => root.querySelector(s);
  const panel = q('.panel');
  const status = q('.status');
  q('.open').onclick = () => panel.classList.toggle('show');
  q('.close').onclick = () => panel.classList.remove('show');

  function show(text) { status.textContent = text; }

  q('.read').onclick = async () => {
    if (state.running) return;
    state.running = true;
    q('.read').disabled = true;
    try {
      show('正在确认登录账号……');
      const nav = await api('https://api.bilibili.com/x/web-interface/nav');
      if (!nav.data?.isLogin || !nav.data?.mid) throw new Error('当前浏览器未登录B站。');
      const uid = Number(nav.data.mid);
      const name = String(nav.data.uname || '');
      const stat = await api(`https://api.bilibili.com/x/relation/stat?vmid=${uid}`);
      const total = Number(stat.data?.follower ?? 0);
      const pageSize = 50;
      const maxPages = Math.max(1, Math.ceil(total / pageSize) + 2);
      const map = new Map();
      let stopReason = '';
      let endpoint = '';

      for (let pn = 1; pn <= maxPages; pn++) {
        show(`账号：${name}\nUID：${uid}\n接口总数：${total}\n正在读取第 ${pn} 页\n当前唯一UID：${map.size}`);
        let result = null;
        const candidates = [
          `https://api.bilibili.com/x/relation/fans?vmid=${uid}&pn=${pn}&ps=${pageSize}&order=desc`,
          `https://api.bilibili.com/x/relation/followers?vmid=${uid}&pn=${pn}&ps=${pageSize}&order=desc`
        ];
        let lastError = null;
        for (const url of candidates) {
          try { result = await api(url); endpoint = new URL(url).pathname; break; }
          catch (e) { lastError = e; }
        }
        if (!result) throw lastError || new Error('两个粉丝接口均失败。');
        const list = Array.isArray(result.data?.list) ? result.data.list : [];
        if (!list.length) { stopReason = `第${pn}页为空`; break; }
        let added = 0;
        for (const raw of list) {
          const item = normalize(raw);
          if (item && !map.has(item.uid)) { map.set(item.uid, item); added++; }
        }
        if (!added) { stopReason = `第${pn}页没有新增UID`; break; }
        if (map.size >= total) { stopReason = '已达到接口总数'; break; }
        if (list.length < pageSize) { stopReason = `第${pn}页不足${pageSize}条`; break; }
        await sleep(350);
      }

      const followers = [...map.values()].sort((a,b)=>(b.followTimestamp||0)-(a.followTimestamp||0));
      state.current = {
        reportType: 'bilibili-current-follower-snapshot',
        reportVersion: 'mobile-test-0.1.0',
        generatedAt: new Date().toISOString(),
        targetUid: uid,
        targetName: name,
        finalReportedTotal: total,
        exportedUniqueTotal: followers.length,
        complete: followers.length >= total,
        endpointUsed: endpoint,
        stopReason,
        followers
      };
      localStorage.setItem(`biliFollowerMobileLatest:${uid}`, JSON.stringify(state.current));
      q('.save').disabled = false;
      show(`读取完成\n账号：${name}\n总数：${total}\n实际唯一UID：${followers.length}\n完整：${state.current.complete}\n停止原因：${stopReason}`);
    } catch (e) {
      show(`失败：${e.message}`);
    } finally {
      state.running = false;
      q('.read').disabled = false;
    }
  };

  q('.save').onclick = () => {
    if (!state.current) return;
    save(`B站粉丝快照_${state.current.targetName}_UID${state.current.targetUid}_${stamp()}.json`, state.current);
  };

  q('.import').onchange = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!state.current) { show('请先读取当前快照。'); return; }
    try {
      const old = JSON.parse(await file.text());
      if (!Array.isArray(old.followers)) throw new Error('旧文件没有 followers 数组。');
      const oldList = unique(old.followers);
      const newList = unique(state.current.followers);
      const oldMap = new Map(oldList.map(x => [x.uid, x]));
      const newMap = new Map(newList.map(x => [x.uid, x]));
      const removed = [...oldMap.values()].filter(x => !newMap.has(x.uid));
      const added = [...newMap.values()].filter(x => !oldMap.has(x.uid));
      state.comparison = {
        reportType: 'bilibili-follower-snapshot-comparison',
        generatedAt: new Date().toISOString(),
        targetUid: state.current.targetUid,
        previousFileName: file.name,
        previousComplete: Boolean(old.complete),
        currentComplete: Boolean(state.current.complete),
        previousCount: oldList.length,
        currentCount: newList.length,
        removedCount: removed.length,
        addedCount: added.length,
        removed,
        added,
        interpretation: 'removed为关系已消失候选，不必然等于主动取关。'
      };
      q('.saveDiff').disabled = false;
      const removedText = removed.length
        ? removed.map(x => `${x.name}（UID ${x.uid}）`).join('\n')
        : '无';
      const addedText = added.length
        ? added.map(x => `${x.name}（UID ${x.uid}）`).join('\n')
        : '无';
      show(`比较完成\n旧：${oldList.length}；当前：${newList.length}\n关系已消失：${removed.length}\n${removedText}\n\n新增：${added.length}\n${addedText}`);
    } catch (e) {
      show(`比较失败：${e.message}`);
    }
  };

  q('.saveDiff').onclick = () => {
    if (!state.comparison) return;
    save(`B站粉丝快照比较_UID${state.comparison.targetUid}_${stamp()}.json`, state.comparison);
  };
})();
