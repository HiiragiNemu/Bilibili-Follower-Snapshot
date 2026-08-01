# 测试分支说明

本分支用于手机端适配和粉丝接口研究，`main` 继续作为稳定版。

## 手机端

推荐使用 **Firefox for Android + Tampermonkey**：

1. 在 Firefox Android 的扩展管理器中安装 Tampermonkey。
2. 打开本分支中的 `userscript/bilibili-follower-mobile-test.user.js` 原始文件并安装。
3. 登录 B站，打开个人空间或“新增粉丝”页面。
4. 点击页面右下角的“粉丝快照测试”按钮。
5. 点击“读取当前快照”。
6. 点击“导入旧快照比较”，选择以前保存的 JSON。

脚本只执行 GET 请求，不读取或导出 Cookie、SESSDATA、bili_jct、密码或验证码。

## 立即识别刚刚取关的人

旧的 921 人 JSON 是完整基准。重新读取当前快照后，执行：

```text
旧快照 UID 集合 - 当前快照 UID 集合
```

即可得到关系已消失的账号。若当前快照仍然 `complete: true`，差集结果可靠；关系消失仍可能是取关、注销、封禁、拉黑、平台清理或被移除。

## 接口探测

`research/bilibili_follower_endpoint_probe.js` 会只读测试：

- `/x/relation/fans` 的页码与 offset 分页；
- `/x/relation/followers` 第 20、21、22 页边界；
- `from=main` 模式；
- 创作中心粉丝统计接口是否返回身份数组。

当前 UID 625821 的粉丝数低于 1000，因此只能验证机制，不能决定性证明第 1001 名以后是否可读。