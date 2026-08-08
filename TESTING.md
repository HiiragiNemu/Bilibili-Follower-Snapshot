# 测试分支说明

本分支用于手机端适配、文件输入回归和粉丝接口研究，`main` 继续作为稳定版。

## 当前基线

- 分支：`test/mobile-endpoint-probe`。
- 2026-08-03 浏览器证据对应的快照脚本 blob：`431d1b06996495670f553cc052433df626e7fcf9`。原始浏览器 JSON 没有嵌入 commit/blob 字段，因此接口实测与代码自动化分别取证。
- 浏览器采集窗口：2026-08-02 18:18–18:37 UTC，即新加坡时间 2026-08-03 02:18–02:37。
- 浏览器族：Chrome、Edge。原始证据没有记录精确版本号，因此公开摘要不补写版本号。
- 公开脱敏报告：[`research/evidence/live-browser-evidence-2026-08-03.md`](./research/evidence/live-browser-evidence-2026-08-03.md)。
- 2026-08-08 自有账号超过 1000 的快照：总数 1065、`/x/relation/fans` 唯一明细 1000、第 21 页空；其 JSON 未记录浏览器族。脱敏回归证据见 [`research/evidence/self-over-1000-evidence-2026-08-09.md`](./research/evidence/self-over-1000-evidence-2026-08-09.md)。

后续代码变更应新建一轮证据，并在报告中写入新的完整 commit。不要把本报告的结果自动归到尚未测试的新提交。

## 手机端

当前测试入口是 **Firefox for Android + Tampermonkey**：

1. 在 Firefox Android 的扩展管理器中安装 Tampermonkey。
2. 打开本分支中的 `userscript/bilibili-follower-mobile-test.user.js` 原始文件并安装。
3. 登录B站，打开个人空间或“新增粉丝”页面。
4. 点击页面右下角的“粉丝快照测试”按钮。
5. 点击“读取当前快照”。
6. 点击“导入旧快照比较”，选择以前保存的 JSON。

脚本只执行粉丝读取所需的 GET 请求，不导出 Cookie、`SESSDATA`、`bili_jct`、密码或验证码。若启用页面内实验性监测，浏览器标签页需保持开启；它不是浏览器关闭后的后台任务。

### 隔离存储与跨入口共享

正常通过 Tampermonkey 安装时，脚本使用以下授权存储 API：

```text
GM_getValue
GM_setValue
GM_deleteValue
GM_listValues
```

这些 API 属于用户脚本隔离存储，不受网页 `localStorage` 的 origin 分区影响。因此同一安装脚本在 `space.bilibili.com` 与 `www.bilibili.com/h5/follow/newFans` 两个匹配入口共享监测状态。页面脚本本身读取不到这份 GM 存储。

持久化内容的完整数据范围限定为：

1. `lastComplete`：每个登录 UID 最新一份通过严格完整性验证的基线；
2. `pendingChange`：尚待用户处理的变化比较队列，可包含多次已检测比较。

每轮无变化结果不累积为历史快照。通知系统另存一个不含粉丝明细的短指纹，只承担提醒去重；该指纹不会压缩、覆盖或清除 `pendingChange`。

变化事务顺序是 `pendingChange → lastComplete → 通知`。如果待处理变化保存失败，基线保持原值；保存成功后，即使后续基线或通知步骤异常，已经落盘的 pending 证据仍保留。

启动或新扫描时会恢复待处理队列，并启用“保存比较/待处理 JSON”和“标记变化已处理”。用户应先检查或导出待处理 JSON，再点击“标记变化已处理”；只有该明确操作成功后，脚本才通过 `GM_deleteValue` 清除对应 `pendingChange`。

### Page Lifecycle

- `pagehide`：清除当前监测计时器，避免页面进入 BFCache 后继续计时；
- BFCache `pageshow`：当 `event.persisted=true`、监测复选框仍选中且计时器为空时，重新挂载计时器；
- 普通刷新：脚本重新初始化，并从 GM 隔离存储恢复 `lastComplete`/`pendingChange`；
- 关闭标签页或浏览器：页面内监测停止，后续打开匹配页面时再恢复持久状态。

## 快照比较

先保存一份显示 `complete: true` 的旧 JSON，再读取新的完整快照并执行：

```text
旧快照 UID 集合 - 当前快照 UID 集合 = 关系已消失候选
当前快照 UID 集合 - 旧快照 UID 集合 = 新增粉丝
```

新旧快照均完整时，集合差分可用于确认“该关系已不在当前名单”。主动取关、注销、封禁、拉黑、平台清理和手动移除仍共享同一种差分表现。

公开脚本只有在扫描前、名单接口、扫描后三个总数一致，且唯一 UID 数与该总数精确相等时才标记完整。当前快照不完整时，“导入旧快照”保持停用；代码触发的导入还会在差集前验证：

1. 新旧双方均明确声明 `complete: true`；
2. 目标 UID 相同；
3. 粉丝 UID 均有效且没有重复；
4. 报告总数、导出总数和唯一 UID 数精确一致；
5. 兼容移动脚本快照时，其逐页总数和 `integrity` 声明也必须通过。

任一检查不满足时清空旧比较结果、不生成新差集，并显示停止原因。文件输入生命周期仍要求事件处理器在任何 `await` 前保存 `event.currentTarget`，异步流程结束后通过已保存的输入元素清空 `value`。对应测试文件是 `tests/file-input-handler-regression.test.mjs`；严格完整性与按钮状态另由 `tests/snapshot-completeness-regression.test.mjs` 覆盖。

## 接口探测

`research/bilibili_follower_endpoint_probe.js` 会只读测试：

- `/x/relation/fans` 与 `/x/relation/followers` 的普通页码分页；
- `/x/relation/fans` 的 `from=main` 官方游标链；
- 第 20、21、22 页默认边界，以及显式 opt-in 的报告末页/下一页边界；
- `followers/unread/count` 与 `followers/Unread/detail` 的三组数组；
- 创作中心当前 `action`、`fan` 与旧版 v2 聚合接口；
- 各模式集合的唯一 UID 数、规范化 SHA-256、交集、单边差集和 Jaccard 值；
- HTTP、业务码、JSON、CORS/网络、超时等失败类别。

### 安装器与手动启动

手机端安装入口是 `userscript/bilibili-follower-endpoint-probe-mobile.user.js` v0.2.0-test，匹配：

```text
https://space.bilibili.com/*
https://www.bilibili.com/h5/follow/newFans*
https://member.bilibili.com/platform/*
```

页面加载时只挂载“粉丝接口只读探测器 v2”面板。点击“开始只读探测”才发起请求；面板实时显示已完成请求数，并提供“取消”按钮。默认配置显示“最多约 84 个 GET”，这是 `nav + stat + unread + 两条普通分页 + 游标 + 六个创作中心请求` 的预计上限，实际数量可更少。

取消会中止当前请求；已完成部分以 `inconclusive` 保存。探测结束默认下载“分享脱敏”JSON，其中账号 UID/昵称、`vmid`/`tmid` 以及每页首尾 UID 已替换。原始报告默认只放在当前页面内存：

```text
globalThis.__BILI_FOLLOWER_ENDPOINT_PROBE__
```

刷新或关闭页面会结束该页内对象。公开协作优先使用默认脱敏文件。

### 普通分页判定

普通分页的 `coverageStatus: complete` 同时要求：

1. stat 总数有效；
2. 顺序采集页没有失败；
3. 顺序页报告的 `data.total` 为单一稳定值并与 stat 精确一致；
4. 顺序页累计的唯一 UID 数与 stat **精确相等**。

唯一数高于 stat、页间 `data.total` 漂移或 `data.total` 与 stat 不一致都会保留为一致性异常，不记作完整。

默认 `includeReportedLastPageBoundary: false`，因此约 142 万样本默认跳过 `pn≈28000` 的报告末页。显式开启该选项后，报告末页和下一页属于独立 boundary 采样；boundary 失败写入 `boundaryStatus`/`boundaryFailedPageCount`，coverage 继续只由顺序页结果决定。

### 集合哈希与数组语义

`modeCollections.collections[].uidSetSha256` 已实现：先过滤正安全整数 UID、数值排序、按换行规范化，再通过 Web Crypto 计算 SHA-256；环境缺少 Web Crypto 时状态为 `unavailable`，哈希值留空。

创作中心 `fan` 的 `data.rank_list` 路径下发现的所有数组（包括经过对象嵌套的后代数组）统一分类为 `content-ranking-not-follower-identity`。排行项即使带 `mid`、`uid`、`uname` 或类似字段，也不提升为粉丝身份候选；`rank_list` 外的强身份数组仍单独保留为待验证候选。

### 字面请求形状

以下占位符只表示运行时值，不是仓库硬编码：

```text
GET https://api.bilibili.com/x/relation/stat?vmid={SELF_UID}
GET https://api.bilibili.com/x/relation/fans?vmid={SELF_UID}&pn={PN}&ps=50&order=desc
GET https://api.bilibili.com/x/relation/followers?vmid={SELF_UID}&pn={PN}&ps=50&order=desc
GET https://api.bilibili.com/x/relation/fans?vmid={SELF_UID}&pn={PN}&ps=50&last_access_ts=0&from=main&re_version=0&offset={OFFSET}&gaia_source=main_web
GET https://api.bilibili.com/x/relation/followers/unread/count
GET https://api.bilibili.com/x/relation/followers/Unread/detail
GET https://member.bilibili.com/x/web/data/action?tmid={SELF_UID}
GET https://member.bilibili.com/x/web/data/fan?tmid={SELF_UID}
GET https://member.bilibili.com/x/web/data/v2/fans/stat/num?period=2
GET https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type={all_fans|follow|unfollow}&period=2
```

游标链把返回的 `offset` 和 `re_version` 原样带到下一页。`offset=rcmd` 可连续重复且仍由递增的 `pn` 推进，所以单独发现重复 offset 时应继续。当前实现以连续空页、连续无新增 UID、请求失败或最大步骤保护结束；即使累计数已等于 stat，也会继续取得结束证据，再把“是否精确相等”用于最终 `coverageStatus`。

## 测试矩阵

| 路线 | Chrome | Edge | 当前结论 |
| --- | --- | --- | --- |
| 登录账号 `/relation/stat` | HTTP 200 / code 0 / total 948 | HTTP 200 / code 0 / total 948 | 两端一致 |
| `/followers` 普通分页 | 19 页得到 948 | 19 页得到 948 | 完整集合 SHA-256 一致 |
| `/fans` 普通边界与游标 | 末页 48，下一页空；游标合计 948 | 由 rcmd 链交叉验证 948 | 与 `/followers` 同集合 |
| `from=main` + `offset=rcmd` | 页 1–18 各加 50，页 19 加 48，页 20 空 | 同样的 50×18 + 48 + 0 | offset 重复 19 次仍推进；最终同一 948 集合 |
| `Unread/detail.has_read` | 250，等于当前倒序前 250 | 同一 250 集合哈希与重叠 | 全部属于当前集合，不是取关历史 |
| 创作中心旧 v2 / `action` | HTTP 200 / code 0 | HTTP 200 / code 0 | 聚合统计，无身份流水 |
| 创作中心 `fan` | HTTP 200 / code 0 | HTTP 200 / code 0 | `rank_list` 是互动/内容排行，不是完整粉丝名单 |
| 约 142 万公开样本 `/followers` | 1000 后空 | 页 20 有 50、页 21 空 | 仅证明该公开样本在采集时点的行为 |
| 同一公开样本 `/fans` 官方游标 | 100 后空，且为 `/followers` 前 100 子集 | 100 后空 | Chrome 交集 100、单边差集 0/900、Jaccard 0.1 |
| 自有账号总数 1065 的 `/fans` 普通分页 | 原始 JSON 未记录浏览器族 | 未形成独立 Edge 证据 | 唯一明细 1000，第 21 页空；直接复现不完整窗口进入旧版差集 |
| Firefox Android + Tampermonkey | 未形成浏览器证据 | 不适用 | 仍需手机端安装、读取、导入和下载全流程记录 |

## 自动化检查

2026-08-09 在合并本轮比较硬闸后执行：

```text
node --check bilibili_follower_snapshot_public.js
node --check userscript/bilibili-follower-mobile-test.user.js
node --check userscript/bilibili-follower-endpoint-probe-mobile.user.js
node --check research/bilibili_follower_endpoint_probe.js
node --test tests/*.test.mjs
git diff --check
```

通过数以交付前最后一次 `node --test tests/*.test.mjs` 的完整输出为准，并同时保存 `fail` 与退出码。自动化结果对应交付提交；浏览器实测仍对应上文单独标出的采集基线，不把新版 probe 的单元测试结果写成浏览器实测。

## 官方 H5 停线的解释

2026-08-03 下载的官方资源：

```text
https://s1.hdslb.com/bfs/static/jinkela-h5/relationship-h5/relationship.e08ed247d6db747c29bfba885f8a2c7b3c121e8d.js
SHA-256 b113b5ffeda52e22c3733339f440b9b340d4bbb1f924ca5fb079f0525b04e353
```

资源里的粉丝列表请求默认 `ps=25`，并用 `isMyPart ? 250 : 100` 参与 `no_more` 计算。因此本人列表最多展示到 250、他人列表最多展示到 100，是该 H5 客户端主动设置的界面停线。本人直接探测已经越过 250 并取得 948，故该源码常量不应写成服务端上限。

## 未完成点与下一轮证据要求

1. 在当前超过 1000 的自有账号上，用 Chrome 与 Edge 分别跑完整普通分页、官方游标和 rcmd 链；现有 1065/1000 JSON 只覆盖一次普通分页，且没有浏览器版本字段。
2. 对每条链记录完整 commit、UTC 时间、浏览器版本、字面参数、HTTP/code、每页长度、新增数、累计唯一数、停止原因和集合 SHA-256。
3. 若出现第 1001 个唯一 UID，单独保存页号、请求 offset、响应 offset 与集合证明；若停在 1000，也保留连续空页或无进展证据。
4. 在 Firefox Android + Tampermonkey 完成安装、按钮显示、快照导出、旧快照导入、异常后再次选择同一文件、下载和页面内监测验证；同时覆盖 `space`/`www` 跨入口 GM 共享、pending 手动确认及 BFCache 恢复。
5. 以不同日期重复公开大样本测试，区分接口规则与名单自然变化；跨日期集合哈希不同本身不表示实现回归。
6. 对创作中心接口按响应语义分类：日期聚合、`rank_list` 全部后代的互动/内容排行、以及排行树以外的身份候选。
7. 为 probe v2 新增浏览器证据：验证手动启动、预计请求数、进度、取消、默认脱敏下载、页内原始报告和三个页面匹配入口。

## 分支文件清单

- `bilibili_follower_snapshot_public.js`：桌面 Console 公开版。
- `userscript/bilibili-follower-mobile-test.user.js`：手机/桌面测试版快照、比较、GM 隔离存储、pending 队列和 BFCache 恢复监测。
- `research/bilibili_follower_endpoint_probe.js`：带手动启动、进度、取消、严格一致性、集合 SHA-256 和脱敏分享版的只读探测器。
- `userscript/bilibili-follower-endpoint-probe-mobile.user.js`：v0.2.0-test 安装入口，覆盖个人空间、H5 新粉丝页和创作中心 `platform`。
- `research/evidence/live-browser-evidence-2026-08-03.md`：公开脱敏证据摘要。
- `research/evidence/self-over-1000-evidence-2026-08-09.md`：自有账号 1065/1000 与旧版误比较的脱敏摘要。
- `tests/file-input-handler-regression.test.mjs`：文件输入生命周期和比较硬闸回归。
- `tests/snapshot-completeness-regression.test.mjs`：公开脚本严格完整性与导入状态回归。
- `tests/endpoint-probe-v2.test.mjs`：接口探测器 v2 回归。
- `tests/mobile-reliability.test.mjs`：移动脚本可靠性与监测回归。
- `README.md`：公开说明与当前证据边界。
- `TESTING.md`：本测试矩阵与复现要求。
- `docs/bilibili-post-template.md`：发布说明范本。
