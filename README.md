# Bilibili Follower Snapshot

B站当前粉丝快照导出与前后比较工具。脚本在本地浏览器中运行，可导出接口本轮实际返回的粉丝 JSON/CSV，并通过前后快照识别新增粉丝和“关系已消失”候选。

> **稳定版与测试版保留各自的完整性口径。**
> 稳定版公开脚本在唯一 UID 数不少于最终报告总数时标记 `complete: true`；测试版移动脚本与 probe v2 进一步要求唯一数精确相等、扫描前后及分页总数一致。比较前请按所用脚本的口径核对报告。

> 本项目不是B站官方工具，也不是历史取关日志查询器。“关系已消失”不应直接等同于对方主动取关。

## 功能

- 自动识别当前登录的B站账号与 UID。
- 根据接口实时报告的粉丝总数自动分页，不预置 UID、当前人数或页数。
- 导出接口实际返回的粉丝 UID、昵称、签名、头像地址和关注时间。
- 保存 JSON 和 CSV。
- 导入旧 JSON 快照，计算：
  - 当前新增粉丝；
  - 旧快照存在、当前快照消失的关系候选。
- 不导出 Cookie、`SESSDATA`、`bili_jct`、密码或验证码。
- 对请求失败、空页、无新增 UID、总数变化和明细不足分别记录；测试版用严格一致性规则阻止部分或矛盾结果标记为完整。

## 2026-08-03 实测结论

脱敏实测覆盖 Chrome 与 Edge，完整记录见 [`research/evidence/live-browser-evidence-2026-08-03.md`](./research/evidence/live-browser-evidence-2026-08-03.md)。

- 登录测试账号在总数为 948 时，`/x/relation/fans` 游标链、`/x/relation/followers` 普通分页和 `from=main`/`offset=rcmd` 链最终取得同一组 948 个 UID；Chrome 与 Edge 的集合 SHA-256 相同。
- `offset=rcmd` 在连续翻页时保持同一个字面值；它是模式哨兵，不是“游标未推进”的充分证据。第 2–19 页仍持续加入新 UID，第 20 页才为空。
- `followers/Unread/detail` 的 `has_read` 恰好是当前倒序名单前 250 个 UID：与前 250 的交集为 250、差集为 0，并且 250 个 UID 全部属于当前 948 人集合。它不是历史取关名单。
- 创作中心旧版 v2 统计与当前 `action` 返回聚合计数/日期序列，没有粉丝身份明细。`fan` 的 `rank_list` 及其所有后代统一按互动/内容排行处理；即使后代项带 `mid`/`uname`，也不按完整粉丝身份列表解释。
- 约 142 万粉丝的公开样本在同轮 Chrome 观测中：`/x/relation/followers` 返回前 1000 个唯一 UID；`/x/relation/fans` 普通/官方游标链返回 100 个唯一 UID，而且这 100 个全部属于前述 1000 人集合。Edge 复现了第 21 页为空和官方游标链 100 人后为空。
- 上述公开样本只说明该公开目标、该时点、该会话下的路由行为；登录测试账号总数低于 1000，因此尚无“自有账号超过 1000”场景的直接证据。
- 官方 H5 客户端资源内部把粉丝列表的**界面拉取停线**写成本人 250、他人 100。该 `no_more` 客户端条件不等同于服务端上限；直接只读探测已在本人场景继续越过 250 并取得 948。

## 使用方法

1. 在桌面版 Chrome 或 Edge 登录B站。
2. 打开 [B站个人空间](https://space.bilibili.com/)。
3. 按 `F12`，切换到 **Console**。
4. 打开 [`bilibili_follower_snapshot_public.js`](./bilibili_follower_snapshot_public.js)，复制全部内容。
5. 粘贴到 Console 并按 Enter。
6. 等待右上角面板完成读取。
7. 点击“保存 JSON”或“保存 CSV”。

Chrome 若禁止直接粘贴，请在 Console 中手工输入：

```text
allow pasting
```

按 Enter 后再粘贴脚本。也可通过仓库页面的 **Code → Download ZIP** 下载项目。

手机端用户脚本、接口探测器和测试步骤见 [`TESTING.md`](./TESTING.md)。

### 测试版页面内监测与存储

手机/桌面测试版通过 Tampermonkey 的 `GM_getValue`、`GM_setValue`、`GM_deleteValue`、`GM_listValues` 使用脚本隔离存储。个人空间的 `space.bilibili.com` 与 H5 新粉丝页的 `www.bilibili.com` 共享同一份用户脚本存储，因此从两个匹配入口进入时可读取同一基线和待处理变化。

- 持久化的完整数据只有每个 UID 最新一份 `lastComplete` 基线，以及尚待处理的 `pendingChange` 比较队列；它不保存每轮无变化快照的历史副本。
- 通知去重另存一个不含粉丝明细的短指纹，只用于避免重复提醒，不替代或删除 `pendingChange` 证据。
- 检测到变化时，脚本先保存 `pendingChange`，再推进 `lastComplete`。待处理队列会跨刷新恢复，并可先下载“比较/待处理 JSON”。
- `pendingChange` 只在用户明确点击“标记变化已处理”（该点击即为清除确认）且删除成功后从隔离存储移除；普通新扫描、通知去重或页面恢复都保留该队列。
- `pagehide` 会停止当前计时器；页面通过 BFCache 恢复并触发 `pageshow` 时，如果监测复选框仍启用，脚本会重新挂载计时器。关闭页面或浏览器后仍停止运行。

## 测试分支的只读接口探测器

测试分支中的 probe v2 已改为手动运行。安装 `userscript/bilibili-follower-endpoint-probe-mobile.user.js` v0.2.0-test 后，在个人空间、H5 新粉丝页或创作中心 `platform` 页面会出现启动面板；加载页面本身只挂载面板，不发起整轮探测。

- 点击“开始只读探测”后，面板显示“已完成请求数 / 默认最多约 84 个 GET”。实际请求数会随总数、提前失败或取消而减少。
- 运行中可点击“取消”；已完成部分保留为 `inconclusive` 报告，不被写成完整结论。
- 默认下载文件是脱敏分享版：账号 UID/昵称、`vmid`/`tmid` 和每页首尾 UID 均被替换。
- 原始报告默认只保存在当前页面内存的 `__BILI_FOLLOWER_ENDPOINT_PROBE__` 中；刷新或关闭页面后该页内对象随之结束。
- 普通分页只有在顺序页无失败、唯一 UID 数与 stat **精确相等**、各顺序页 `data.total` 稳定且与 stat 一致时才记为完整。
- 超远的“报告末页/末页后一页”采样默认关闭；开启后也作为独立 boundary 结果记录，其失败不污染顺序分页结论。
- 三条模式集合会输出规范化 UID 集合 SHA-256 及重叠统计。游标链继续以连续空页、连续无新增 UID、请求失败或最大步数保护结束；达到报告总数只用于最终一致性判断，不是提前停止条件。

这些项目描述测试分支中的 probe v2 行为。交付快照脚本 blob 为 `431d1b06996495670f553cc052433df626e7fcf9`。该轮 Chrome/Edge JSON 支持接口响应与集合结论，但原始 JSON 没有写入 commit 或脚本 hash；文件输入修复另由回归测试与当次页面内观察验证。新版手动启动器、脱敏下载和严格一致性规则由自动化测试覆盖，均与浏览器接口实测分开标注。

## 追踪后续关系变化

第一次运行时保存 JSON 作为基准快照。过一段时间后再次运行脚本，取得新快照，然后在工具面板点击“导入旧快照”。

脚本按 UID 计算：

```text
旧快照 UID 集合 - 当前快照 UID 集合 = 关系已消失候选
当前快照 UID 集合 - 旧快照 UID 集合 = 新增粉丝
```

“关系已消失”还可能由以下情况导致：

- 账号注销；
- 账号封禁；
- 对方拉黑；
- 平台清理；
- 你移除了粉丝；
- 某次快照因服务端行为、网络失败或明细停线而不完整。

只有新旧两个快照都显示 `complete: true` 时，差集才具有较高可信度。任一快照不完整时，差集只表示两个“已取得集合”之间的变化，不代表完整取关名单。

## 数据边界

实测表明，不同路由、目标类型和客户端路径的停线并不相同：

| 数据源 | 2026-08-03 直接观测 | 解释边界 |
| --- | --- | --- |
| `/x/relation/stat` | 能报告超过 1000 的总粉丝数 | 只有总数，没有身份明细 |
| `/x/relation/followers` | 公开大样本取得 1000 后下一页为空 | 是该样本的直接观测，不外推为所有自有账号的恒定上限 |
| `/x/relation/fans` 普通/官方游标 | 登录测试账号取得完整 948；公开大样本取得 100 | 目标/会话相关，需依赖本轮返回与完整性校验 |
| 官方 H5 客户端 | 源码设置本人 250、他人 100 的 UI 停线 | 客户端 `no_more` 条件，不是独立的服务端上限证据 |
| 创作中心统计 | 返回聚合计数、趋势和排行 | 没有发现完整粉丝身份或历史取关身份流水 |

脚本仍保留 1000 作为已知明细边界的保守诊断值，但最终 `complete` 只由“唯一实取数是否达到报告总数”决定。若总数是 1050 而最终仅取得 1000，输出会记录 `exportedUniqueTotal: 1000`、`finalReportedTotal: 1050`、`complete: false`；这描述本轮结果，不宣称第 1001–1050 名在所有路径下永久不可达。

## 尚未覆盖

- 在粉丝总数超过 1000 的自有账号上完成同一套 Chrome/Edge 端到端实测。
- 证明某个当前接口能稳定读取自有账号第 1001 名以后的身份明细。
- 恢复首次建立快照以前已经消失的全部关系。
- 从现有差集严格区分主动取关、注销、封禁、拉黑、移除或平台清理。
- 在B站官方 App 内直接运行脚本，或在浏览器完全关闭后持续后台监测。
- 建立长期、跨日期的接口漂移样本；当前结论仅对应报告中的采集窗口。

## 分支文件

- [`bilibili_follower_snapshot_public.js`](./bilibili_follower_snapshot_public.js)：桌面 Console 公开版快照与比较工具。
- [`userscript/bilibili-follower-mobile-test.user.js`](./userscript/bilibili-follower-mobile-test.user.js)：手机/桌面测试版用户脚本，提供快照、比较、GM 隔离存储、待处理变化队列及支持 BFCache 恢复的页面内监测。
- [`research/bilibili_follower_endpoint_probe.js`](./research/bilibili_follower_endpoint_probe.js)：手动启动的只读 GET 探测器，提供进度、取消、严格分页一致性、集合 SHA-256 和默认脱敏分享报告。
- [`userscript/bilibili-follower-endpoint-probe-mobile.user.js`](./userscript/bilibili-follower-endpoint-probe-mobile.user.js)：v0.2.0-test 安装入口，匹配个人空间、H5 新粉丝页与创作中心 `platform` 页面。
- [`research/evidence/live-browser-evidence-2026-08-03.md`](./research/evidence/live-browser-evidence-2026-08-03.md)：Chrome/Edge 公开脱敏证据摘要。
- [`tests/file-input-handler-regression.test.mjs`](./tests/file-input-handler-regression.test.mjs)：旧快照文件输入生命周期回归测试。
- [`tests/endpoint-probe-v2.test.mjs`](./tests/endpoint-probe-v2.test.mjs)：游标哨兵、失败分类、身份数组分类和参数记录回归测试。
- [`tests/mobile-reliability.test.mjs`](./tests/mobile-reliability.test.mjs)：移动脚本的完整性、端点隔离、状态清理和监测回归测试。
- [`TESTING.md`](./TESTING.md)：分支测试矩阵、复现规则与未完成项。
- [`docs/bilibili-post-template.md`](./docs/bilibili-post-template.md)：B站发布说明范本。

## 隐私与安全

脚本在当前浏览器页面本地执行，并使用现有B站登录会话调用粉丝查询接口。结果保留在本地，导出内容排除登录凭据。公开分享导出的 JSON/CSV 前，请先移除粉丝昵称、UID、签名等身份信息。仓库中的证据摘要只保留计数、集合哈希、重叠统计、请求形状与响应状态；原始 UID 列表不进入公开证据文件。

## 许可

MIT License。详见 [`LICENSE`](./LICENSE)。
