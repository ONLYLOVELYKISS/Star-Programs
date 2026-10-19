# GitHub Actions 每日项目采集方案

## 数据层

`.github/workflows/github-daily-collect.yml` 每天 01:00 UTC（北京时间 09:00）运行，也支持手动触发并指定 `top_n`。

`scripts/collect-github-daily.mjs` 会：

1. 读取 GitHub Trending daily 页面，默认取前十。
2. 用 GitHub 官方仓库 API 读取描述、语言、累计 Star、许可、主题和更新时间。
3. 读取官方 README 摘要。
4. 调用 GitHub REST Search API，分别按 Star、Fork、近期更新和带 `help wanted` 标签的 issue 数排序，保存每项前 20 个搜索结果及仓库统计。
5. 从 Trending 前十中按榜单顺序选出此前未作为文章候选的项目；不足三项时，再从官方 Search API 排名补足。每个快照保存 `selectedProjects`，`data/github-trending/selection-history.json` 保存已选仓库清单，跨日去重不依赖保留全部快照。该清单已用现有 2026-10-17 至 2026-10-19 文章中介绍过的项目初始化。旧快照没有 `selectedProjects` 字段时，以当时 Trending 前三作为已选记录。
6. 与最近的历史 JSON 比较，生成“两个采集快照之间的估算 Star 增量”。这不是官方全天新增量。
7. 写入 `data/github-trending/YYYY-MM-DD.json` 和 `latest.json`。

抓取失败也会写入带 `failureReason` 的 JSON，工作流继续上传 Artifact，避免用旧数据伪装成新数据。工作流使用内置 `GITHUB_TOKEN` 请求官方 API，不需要另配个人令牌。

## 内容层

Codex 或其他写作程序只需读取 `data/github-trending/latest.json`：

- 用 `projects` 生成 Notion 数据库文章。
- 用同一份数据生成微信公众号发布稿。
- 将相同 Markdown 写入本地 `Github每日星标项目/YYYY-MM-DD.md`。

文章以 `selectedProjects` 的三项作为每日介绍项目；`projects` 保留 Trending 榜单快照，`githubApiSearchRankings` 提供 GitHub 官方 REST Search API 的多维排名候选及官方统计数据。若 `selectionShortfall` 非空，说明当前候选源不足三个从未介绍过的仓库，应如实说明并避免重复介绍。公众号稿不要为了凑足三项而重新介绍已覆盖项目。

Notion 写入可以继续使用 MCP；若 MCP OAuth 不稳定，可改为在 GitHub Secrets 中保存 Notion Integration Token，直接调用 Notion API。

## 重要口径

- Trending 的今日 Star 是页面采集时显示的 daily 信号。
- `estimatedStarsSincePreviousSnapshot` 是两个快照的差值，不是官方自然日新增量。
- 每一篇文章应保存 `capturedAtChinaTime`、来源 URL 和失败原因。
- GitHub Search API 是带查询条件的排序搜索结果，不等于一个穷尽所有仓库、官方发布的统一排行榜；搜索可能不完整，文章需保留来源口径和采集时点。
- GitHub Trending 的 daily 信号与 Search API 的 Star/Fork/更新/Help Wanted 排序是不同数据，不能混为同一排名。
