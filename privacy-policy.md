# X Tweet Local Backup — Privacy Policy

_Last updated: 2026-09-23_

## Summary

X Tweet Local Backup does not collect, transmit, sell or share data. Everything it saves stays in your own browser, on your own computer.

## What the extension handles

When you publish a post, reply or quote on x.com, the extension reads that post out of the network response your browser had already received, and saves it to the extension's own local database (IndexedDB). A saved record contains:

- the text you published, and its language
- the links in it, including the real destination behind any `t.co` shortlink
- hashtags and @mentions
- image, video and GIF metadata — plus the media files themselves, only if you turn on media caching
- poll choices and closing time
- when you published it, and when it was saved
- your own display name, @username and avatar URL, as returned with your post
- engagement counts (likes, reposts, replies, views)

It also records which of your posts you later edited or deleted, so the archive can show that.

## Where it is stored

Entirely in your browser's local storage for this extension. Nothing is sent anywhere. The extension makes no requests of its own to X or to any other server, with the single optional exception described below.

## What the extension never does

- It never reads, stores or transmits cookies, authentication tokens, `auth_token`, `ct0`, `Authorization` headers or any other credential.
- It never uploads your data to any server. There is no analytics, no telemetry, no crash reporting and no advertising.
- It never sells or shares data with third parties. There is no third party.
- It does not read private messages.
- It does not record your browsing history, clicks, mouse position, scrolling or keystrokes.
- It does not automate anything: no automatic posting, replying, liking, following or reposting, and no simulated clicks or typing.

## The one optional network request

If you turn on media caching, the extension downloads the image, video or GIF files attached to your own posts from `pbs.twimg.com` and `video.twimg.com` so that they remain viewable offline. This happens only after you enable the setting and grant that permission, and it downloads only media attached to posts you published.

## Retention and deletion

Data stays until you delete it. From the extension's popup you can delete individual records, delete whole categories (older versions of edited posts, or posts you deleted on X), or clear everything at once. Uninstalling the extension, deleting your browser profile, or clearing the browser's extension data also removes it permanently.

There is no copy anywhere else, so exporting the JSON from time to time is recommended.

## Permissions and why they are needed

| Permission | Why |
|---|---|
| `storage` | Saves your settings and diagnostics counters. |
| `unlimitedStorage` | Keeps the browser from evicting your archive under storage pressure. |
| `x.com`, `twitter.com` | Lets a content script observe the network responses the page already produces when you publish. This is the extension's only data source. |
| `pbs.twimg.com`, `video.twimg.com` (optional) | Only requested if you turn on media caching. |

## Changes

Any change to this policy will be published at this URL, with the date above updated.

## Contact

<YOUR EMAIL HERE>

---

# X Tweet Local Backup — 隐私政策

_最后更新：2026-09-23_

## 概述

X Tweet Local Backup 不收集、不传输、不出售、不共享任何数据。它保存的一切都留在你自己的浏览器、你自己的电脑上。

## 这个扩展处理哪些数据

当你在 x.com 上发布推文、回复或引用时，扩展会从浏览器**已经收到**的网络响应中读出这条内容，并保存到扩展自身的本地数据库（IndexedDB）。一条记录包含：

- 你发布的正文，以及它的语言
- 正文中的链接，包括 `t.co` 短链背后的真实目标地址
- 话题标签和 @提及
- 图片、视频、GIF 的元数据 —— 以及媒体文件本身（仅在你开启媒体缓存时）
- 投票的选项和截止时间
- 发布时间，以及归档时间
- 你自己的显示名、@用户名和头像地址（随你的推文一起返回的）
- 互动计数（点赞、转推、回复、浏览量）

它还会记录你后来**编辑或删除**了哪些帖子，以便归档能反映这些变化。

## 数据存在哪里

全部存在你的浏览器为这个扩展分配的本地存储里。**没有任何数据被发送到任何地方。** 除了下面提到的唯一一个可选请求之外，扩展不会主动向 X 或任何其他服务器发起请求。

## 这个扩展绝不会做的事

- 绝不读取、保存或传输 Cookie、身份验证令牌、`auth_token`、`ct0`、`Authorization` 请求头或任何其他凭据。
- 绝不上传你的数据到任何服务器。没有统计分析、没有遥测、没有崩溃上报、没有广告。
- 绝不出售或共享数据给第三方。**不存在第三方。**
- 不读取私信。
- 不记录你的浏览历史、点击、鼠标位置、滚动或按键。
- 不做任何自动化操作：不自动发帖、回复、点赞、关注、转推，也不模拟点击或输入。

## 唯一一个可选的网络请求

如果你开启媒体缓存，扩展会从 `pbs.twimg.com` 和 `video.twimg.com` 下载**你自己帖子**所附带的图片、视频或 GIF 文件，以便离线也能查看。这仅在你开启该设置并授予相应权限后才会发生，且只下载你自己发布的帖子所附带的媒体。

## 保存期限与删除

数据会一直保留到你删除它。在扩展弹窗里，你可以删除单条记录、按类别批量删除（编辑前的旧版本，或你在 X 上已删除的帖子），或一次性清空全部。卸载扩展、删除浏览器配置文件、或清除浏览器的扩展数据，也会永久移除这些数据。

**没有任何其他副本**，所以建议定期导出 JSON 作为备份。

## 权限及用途

| 权限 | 用途 |
|---|---|
| `storage` | 保存你的设置和诊断计数器。 |
| `unlimitedStorage` | 避免浏览器在存储压力下清除你的归档。 |
| `x.com`、`twitter.com` | 让内容脚本能够观察你发布时页面自身已经产生的网络响应。这是本扩展唯一的数据来源。 |
| `pbs.twimg.com`、`video.twimg.com`（可选） | 仅在你开启媒体缓存时才会申请。 |

## 变更

本政策的任何变更都会发布在此 URL，并更新上方的日期。

## 联系方式

<在此填入你的邮箱>
