// ==UserScript==
// @name         B站粉丝候选接口探测器（手机测试版）
// @namespace    https://github.com/HiiragiNemu/Bilibili-Follower-Snapshot
// @version      0.2.0-test
// @description  只读测试普通分页、官方游标、Unread与创作中心接口，记录失败类别、集合重叠并下载JSON报告
// @author       HiiragiNemu
// @match        https://space.bilibili.com/*
// @match        https://www.bilibili.com/h5/follow/newFans*
// @match        https://member.bilibili.com/platform/*
// @run-at       document-idle
// @grant        none
// @require      https://raw.githubusercontent.com/HiiragiNemu/Bilibili-Follower-Snapshot/6f832e88bb3be45d15b5aabd2df016156bcb9fc3/research/bilibili_follower_endpoint_probe.js
// @downloadURL  https://raw.githubusercontent.com/HiiragiNemu/Bilibili-Follower-Snapshot/test/mobile-endpoint-probe/userscript/bilibili-follower-endpoint-probe-mobile.user.js
// @updateURL    https://raw.githubusercontent.com/HiiragiNemu/Bilibili-Follower-Snapshot/test/mobile-endpoint-probe/userscript/bilibili-follower-endpoint-probe-mobile.user.js
// ==/UserScript==

// 实际测试逻辑通过 @require 加载。页面只挂载手动启动/取消面板，不会在刷新时自动发起探测。
