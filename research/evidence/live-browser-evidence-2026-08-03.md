# 2026-08-03 Chrome / Edge 粉丝接口脱敏证据摘要

## 1. 范围与隐私

本文件只公开请求形状、时间、HTTP/业务码、计数、停止条件、集合 SHA-256 和集合重叠。它不包含登录账号 UID、登录昵称、公开样本 UID、任何 UID 列表、Cookie、`SESSDATA`、`bili_jct` 或访问令牌。

原始浏览器 JSON 含身份数据，仅作为本地核验材料，不进入本公开目录。集合哈希的生成对象是排序后的唯一 UID 集合；哈希用于证明同一轮集合相等，不用于还原成员。

## 2. 证据基线

| 项目 | 值 |
| --- | --- |
| 交付快照脚本 blob | `431d1b06996495670f553cc052433df626e7fcf9` |
| 基线主题 | `fix: retain baseline input across async comparison` |
| Chrome 采集 | `2026-08-02T18:18:34.497Z` 至 `2026-08-02T18:30:49.974Z` |
| Edge 采集 | `2026-08-02T18:37:47.575Z` |
| 本地日期 | 新加坡时间 2026-08-03 |
| 浏览器版本 | 原始证据只记录浏览器族，未记录精确版本号 |

原始浏览器 JSON 没有嵌入 commit/blob 字段，因此表中的交付脚本 blob 不作为“浏览器执行了该 blob”的独立证明。probe v2 的后续改动由自动化测试验证，未冒充为本轮浏览器实测。

原始材料的文件级 SHA-256：

| 本地原始材料 | SHA-256 |
| --- | --- |
| `chrome-follower-endpoint-evidence-2026-08-03.json` | `c7e2bca3e5c6bc999ec1646f914349fd0dd182ba3cd028dae3cd7a9370ef1355` |
| `chrome-follower-set-comparison-2026-08-03.json` | `2ecae82868e1436b01ad5d5336ad3bf3a1b0e87eb8a5abc832651ff0e4c72dee` |
| `chrome-official-h5-chain-evidence-2026-08-03.json` | `b820646afe54329774b81881387769b81d57043a2eec5f01637beadf6c2c64f0` |
| `chrome-rcmd-unread-evidence-2026-08-03.json` | `b65bca0a34923ee228e096f4517db864531b2eeb8e125c2ec2b9d26f8f68691c` |
| `edge-cross-browser-evidence-2026-08-03.json` | `dd45e1e1d89401e34e63c3a82c48cf0fc6d6072b8d9ef2419ed1ea8b0b14b0b8` |

官方 H5 资源：

- URL：`https://s1.hdslb.com/bfs/static/jinkela-h5/relationship-h5/relationship.e08ed247d6db747c29bfba885f8a2c7b3c121e8d.js`
- 下载文件：`relationship-h5.e08ed247.js`
- URL 记录与本地文件 SHA-256：`b113b5ffeda52e22c3733339f440b9b340d4bbb1f924ca5fb079f0525b04e353`

## 3. 字面请求参数

运行时 UID 被替换为类型化占位符，其他参数保留本轮字面值：

```text
GET https://api.bilibili.com/x/relation/stat?vmid={SELF_UID}

GET https://api.bilibili.com/x/relation/fans
  ?vmid={TARGET_UID}&pn={PN}&ps=50&order=desc

GET https://api.bilibili.com/x/relation/followers
  ?vmid={TARGET_UID}&pn={PN}&ps=50&order=desc

GET https://api.bilibili.com/x/relation/fans
  ?vmid={TARGET_UID}&pn={PN}&ps=50&last_access_ts=0
  &from=main&re_version=0&offset={OFFSET}&gaia_source=main_web

GET https://api.bilibili.com/x/relation/followers/unread/count
GET https://api.bilibili.com/x/relation/followers/Unread/detail

GET https://member.bilibili.com/x/web/data/action?tmid={SELF_UID}
GET https://member.bilibili.com/x/web/data/fan?tmid={SELF_UID}
GET https://member.bilibili.com/x/web/data/v2/fans/stat/num?period=2
GET https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type=all_fans&period=2
GET https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type=follow&period=2
GET https://member.bilibili.com/x/web/data/v2/fans/stat/graph?type=unfollow&period=2
```

游标链将响应的 `offset`、`re_version` 原样带入下一页；`pn` 每页递增。本轮所有保存了 `httpStatus` 的成功接口条目均为 HTTP 200，业务码均为 `code=0`。Chrome 的后续 rcmd 集合文件只重复保存了 `code`，Edge 交叉文件同时保存 HTTP 200 与 `code=0`。

## 4. 登录测试账号：948 人完整集合

`/x/relation/stat` 在 Chrome 与 Edge 都返回 HTTP 200、`code=0`、`follower=948`。

### 4.1 路线结果

| 路线 | 页进度 | 唯一 UID | 集合 SHA-256 |
| --- | --- | ---: | --- |
| Chrome `/fans` 普通 offset 链 | 18 页 × 50；第 19 页 48；第 20 页 0 | 948 | `a19d152f02c5c9a4fb7b1f86abdf516b985ec6f3c8fe639f572b25282dcc03da` |
| Chrome `/followers` 普通 pn 链 | 18 页 × 50；第 19 页 48 | 948 | `a19d152f02c5c9a4fb7b1f86abdf516b985ec6f3c8fe639f572b25282dcc03da` |
| Chrome `/fans` `from=main` / rcmd 链 | 18 页 × 50；第 19 页 48；第 20 页 0 | 948 | `a19d152f02c5c9a4fb7b1f86abdf516b985ec6f3c8fe639f572b25282dcc03da` |
| Edge `/followers` 普通 pn 链 | 18 页 × 50；第 19 页 48 | 948 | `a19d152f02c5c9a4fb7b1f86abdf516b985ec6f3c8fe639f572b25282dcc03da` |
| Edge `/fans` `from=main` / rcmd 链 | 18 页 × 50；第 19 页 48；第 20 页 0 | 948 | `a19d152f02c5c9a4fb7b1f86abdf516b985ec6f3c8fe639f572b25282dcc03da` |

普通 `/fans` 与 `/followers` 的第 1 页各 50 人且页集合哈希相同；第 19 页各 48 人且页集合哈希相同；第 20–22 页都为空。完整链的集合比较如下：

| 比较 | A | B | 交集 | 仅 A | 仅 B | Jaccard |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chrome `/fans` vs `/followers` | 948 | 948 | 948 | 0 | 0 | 1 |
| Chrome `/fans` vs rcmd | 948 | 948 | 948 | 0 | 0 | 1 |
| Chrome rcmd vs普通当前集合 | 948 | 948 | 948 | 0 | 0 | 1 |
| Edge rcmd vs `/followers` | 948 | 948 | 948 | 0 | 0 | 1 |

结论限于这次 948 人样本：普通页码、offset 游标和 rcmd 模式最终是同一当前粉丝集合，Chrome 与 Edge 交叉一致。

### 4.2 `offset=rcmd` 是可重复的模式哨兵

Chrome 与 Edge 都观察到：

- 第 1 页响应 `offset=rcmd`；
- 第 2–20 页请求继续携带 `offset=rcmd`，响应仍是 `offset=rcmd`；
- 相对首次响应共有 19 次重复 offset；
- 第 2–18 页各新增 50 个 UID，第 19 页新增 48 个 UID；
- 第 20 页列表为空，累计仍为 948。

因此，“响应 offset 与上一页相同”不是停止证据。探测器应继续递增 `pn`，再以连续空页、连续无新增 UID、请求失败或最大步骤保护决定停止；报告总数只参与最终 coverage 判断。

## 5. Unread 端点不是取关历史

Chrome 与 Edge 的 `followers/unread/count` 都返回 `code=0`、`count=0`、`time=0`。`followers/Unread/detail` 返回 `code=0`、`total=948`：

| 分组 | 长度 | 唯一 UID | 集合 SHA-256 |
| --- | ---: | ---: | --- |
| `prior_unread` | 0 | 0 | 空集合 |
| `normal_unread` | 0 | 0 | 空集合 |
| `has_read` | 250 | 250 | `3b70ed74ecc78b99ba1b68a95c3dcecfd828f2a82363c5aa6b6993c0dbba3155` |

`has_read` 的集合关系：

| 比较 | A | B | 交集 | 仅 A | 仅 B | Jaccard |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `has_read` vs 完整当前集合 | 250 | 948 | 250 | 0 | 698 | 0.2637130802 |
| `has_read` vs 当前倒序前 250 | 250 | 250 | 250 | 0 | 0 | 1 |
| `has_read` vs rcmd 完整集合 | 250 | 948 | 250 | 0 | 698 | 0.2637130802 |

Chrome 与 Edge 的 `has_read` 集合哈希也相同。它是当前倒序名单的前 250 人缓存/分组，全体仍在当前 948 人集合中；本轮证据排除了“`has_read` 是历史取关者列表”这一解释。

## 6. 创作中心端点

下列请求在本轮均为 HTTP 200、`code=0`：

| 端点 | 响应结构 | 身份结论 |
| --- | --- | --- |
| `v2/fans/stat/num?period=2` | `all_fans`、`follow`、`unfollow` 等汇总字段 | 聚合数值，没有身份数组 |
| `v2/fans/stat/graph?type=all_fans|follow|unfollow&period=2` | 90 个 `date_key` / `total_inc` 趋势记录 | 日期聚合，没有身份数组 |
| `x/web/data/action?tmid={SELF_UID}` | `relation_fans_day`、`relation_fans_history`、`relation_fans_month`，按日期区分 `follow` / `unfollow` | 数量时间序列，没有 UID/昵称流水 |
| `x/web/data/fan?tmid={SELF_UID}` | `rank_list.dynamic_act`、`video_act`、`video_play`，每组 10 条 | 互动/内容排行，不是完整粉丝或取关身份列表 |

`fan` 的排行项确实带有 `mid`、`uname` 等成员字段，但路径名和响应结构表明它们是排行对象。探测报告里的 `name: fan` 只是端点标签；仅凭该 `name` 或排行项出现身份字段，不足以把数组解释为完整粉丝身份源。

## 7. 约 142 万粉丝的公开样本

公开样本总数在采集期间自然变化：Chrome 先后报告 1,417,961 与 1,417,962，Edge 稍后报告 1,417,979。以下集合比较使用同一个 Chrome 采集轮次，避免把跨时点变动混入重叠统计。

### 7.1 Chrome 同轮集合

| 路线 | 页进度 | 唯一 UID | 集合 SHA-256 |
| --- | --- | ---: | --- |
| `/followers` 普通 pn | 第 1–20 页各 50，第 21 页 0 | 1000 | `304fcf1fbf8449a40f702d3228e80b678fbcc02ecac94a87906b15fa79fbedeb` |
| `/fans` 普通/offset 链 | 前两页各 50，第 3 页 0 | 100 | `dc4491a6a6257637c82716382cdc5919298374d2386fdfd2717af9ec2199c2f0` |

| 比较 | A | B | 交集 | 仅 A | 仅 B | Jaccard |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/fans` 100 vs `/followers` 1000 | 100 | 1000 | 100 | 0 | 900 | 0.1 |

所以 `/fans` 的 100 人集合是 `/followers` 前 1000 人集合的真子集，没有形成另一组可补齐的身份来源。另一次按官方 H5 参数执行的 Chrome 游标链同样在 100 人后返回空页；由于目标名单在变化，该轮集合哈希是 `f2aafbebb27d0f26407ab5cf9675c9e971d19b1ec9e6bef1a3512ca11f916516`，不与上一轮做逐成员等同推断。

### 7.2 Edge 交叉检查

- `/followers`：第 1 页 50、第 20 页 50、第 21 页 0，HTTP 200、`code=0`；
- `/fans` 官方游标：两页各 50，第 3 页 0，共 100，HTTP 200、`code=0`；
- Edge 该时点 `/fans` 100 人集合 SHA-256：`7c22f946a3e7e387b076809b5cd8f5465ba0750c32d403b6466a9a3d05d435b8`。

Edge 复现了边界形状。由于 Edge 原始文件只抽查 `/followers` 的第 1、20、21 页，没有在该时点保存完整 1000 人集合，因此不补写 Edge 的完整子集统计。

### 7.3 证据边界

这个公开样本证明的是：该目标在这些采集时点，`/followers` 可达 1000，而 `/fans` 普通/官方游标可达 100，且 Chrome 同轮的 100 是 1000 的前缀子集。它不证明登录自有账号超过 1000 时会采用相同策略，也不证明这些数字是所有目标、所有会话、所有日期的永久常量。

## 8. 官方 H5 的 250 / 100 是客户端显示停线

已哈希的官方资源中，粉丝请求默认 `ps=25`，并使用以下等价逻辑计算 `no_more`：

```text
displayCap = isMyPart ? 250 : 100
no_more = list.length < ps
       || ps * page >= reportedTotal
       || page >= displayCap / ps
```

这表示官方 H5 自己在本人第 10 页、他人第 4 页设置列表结束条件，也就是本人 250、他人 100。直接 rcmd 探测在本人场景继续取得了 948，所以该客户端结束条件不等于服务端身份明细上限。公开大样本的 `/fans` 恰好也在 100 停止，是独立的响应观测；结论依据是实际空页，而不是只凭客户端常量推断。

## 9. 当前仍缺的证据

1. 粉丝总数超过 1000 的自有账号，同一时点在 Chrome 与 Edge 的完整普通分页、offset 和 rcmd 链。
2. 第 1001 个唯一 UID 的直接返回记录，或自有账号在 1000 处连续空页/无进展的直接记录。
3. Firefox Android + Tampermonkey 的安装、快照、导入、下载及页面内监测全流程证据。
4. 跨日期重复测试，用于识别接口规则漂移与公开名单自然变化。
5. 对“关系已消失”原因的外部事件证据；集合差分本身只证明当前关系缺席。
6. 首次快照以前的完整历史关系材料；当前接口和聚合趋势没有给出历史身份流水。

## 10. 结论

- 948 人登录样本：Chrome 与 Edge 上，普通分页、offset 和 rcmd 得到同一完整集合。
- rcmd：重复 offset 是模式哨兵，仍应随 `pn` 推进。
- Unread：`has_read` 是当前前 250，不是取关历史。
- 创作中心：旧 v2 和 `action` 是聚合；`fan` 是排行语义。
- 公开大样本：`followers=1000`、`fans=100`，Chrome 同轮的 100 是 1000 的子集；Edge 复现边界形状。
- 自有账号超过 1000 的行为仍待直接实测。稳定版公开脚本沿用“实取唯一数不少于最终报告总数”的 `complete` 规则；测试版移动脚本与 probe v2 进一步要求唯一数精确相等、扫描前后及分页总数一致。
