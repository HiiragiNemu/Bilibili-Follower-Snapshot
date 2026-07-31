# Bilibili Follower Snapshot

B站当前粉丝完整导出与快照比较工具。脚本在本地浏览器中运行，可导出当前粉丝 JSON/CSV，并通过前后快照识别新增粉丝和“关系已消失”候选。

> 本项目不是B站官方工具，也不是历史取关日志查询器。“关系已消失”不应直接等同于对方主动取关。

## 功能

- 自动识别当前登录的B站账号与 UID。
- 根据接口实时报告的粉丝总数自动分页，不写死 UID、人数或页数。
- 导出当前粉丝的 UID、昵称、签名、头像地址和关注时间。
- 保存 JSON 和 CSV。
- 导入旧 JSON 快照，计算：
  - 当前新增粉丝；
  - 旧快照存在、当前快照消失的关系候选。
- 不读取或导出 Cookie、`SESSDATA`、`bili_jct`、密码或验证码。
- 只有实际取得人数达到接口报告总数时，才标记 `complete: true`。

## 使用方法

1. 在桌面版 Chrome、Edge 等浏览器登录B站。
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

按 Enter 后再粘贴脚本。

无法直接下载 `.js` 时，可使用内容完全相同的 [`bilibili_follower_snapshot_public.txt`](./bilibili_follower_snapshot_public.txt)。需要下载整个项目包时，点击仓库页面的 **Code → Download ZIP**。

## 追踪后续取关或关系变化

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
- 某次快照因服务端限制而不完整。

只有新旧两个快照都显示 `complete: true` 时，差集才具有较高可信度。

## “无固定人数上限”的准确含义

脚本自身不设置固定人数上限，页数根据接口实时报告的总数动态计算。但它不能绕过B站服务端自身的：

- 展示上限；
- 接口分页限制；
- 风控；
- 权限限制；
- 未来接口变更。

因此，当接口只返回部分粉丝时，工具会明确标记结果为不完整，不会伪称已经导出全部粉丝。

## 不能做到的事情

本工具不能仅凭当前粉丝接口恢复：

- 首次建立快照以前已经取关的全部账号；
- B站服务器未公开提供的关注关系变更流水；
- 从未出现在旧名单、旧缓存或其他历史证据中的账号。

## 文件

- `bilibili_follower_snapshot_public.js`：公开版完整脚本。
- `bilibili_follower_snapshot_public.txt`：同内容 TXT 备用版。
- `docs/bilibili-post-template.md`：B站发布说明范本。

## 隐私与安全

脚本在当前浏览器页面本地执行，并使用现有B站登录会话调用粉丝查询接口。代码不会将结果上传到第三方服务器，也不会导出登录凭据。公开分享导出的 JSON/CSV 前，请自行确认其中的粉丝昵称、UID、签名等信息是否适合公开。

## 许可

MIT License。详见 [`LICENSE`](./LICENSE)。
