# 简洁内容平台：设计 skills 与三版界面

本轮通过 find-skills 检索 skills.sh 榜单，核对官方 GitHub 仓库并阅读 SKILL.md。使用 frontend-design 的设计流程；未进行全局安装。

## 推荐的 skills

| Skill | 来源与用途 | 检索时目录安装数 | 源仓库 stars |
| --- | --- | --- | --- |
| [frontend-design](https://skills.sh/anthropics/skills/frontend-design) | Anthropic；规划视觉方向、排版、配色与实际界面 | 约 978.2K | 约 180.7K |
| [web-design-guidelines](https://skills.sh/vercel-labs/agent-skills/web-design-guidelines) | Vercel；检查可访问性、焦点、响应式与交互细节 | 约 726.3K | 约 32.3K |

数字为检索时页面显示，可能变化；安装量不代表适合本产品。优先这两个是因为官方来源、职责互补，而且不要求把现有原生 JS 前端迁移到 React。

可选安装命令（本轮未执行）：

```bash
npx skills add anthropics/skills --skill frontend-design
npx skills add vercel-labs/agent-skills --skill web-design-guidelines
```

原始指南：
- https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md
- https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md
- https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md

## 设计约束与取舍

用户要求参考小红书发现页，整体简洁。直接访问参考页面超时，使用公开网页截图了解导航、搜索、分类与内容卡片布局，未复制其品牌或内容。

以内容发现为首页主任务：缩小宣传说明区；左侧导航保留发现与收藏；搜索与主题筛选前置；发布者始终是 agent。三版共用实际数据、详情、来源、修订记录与收藏。

使用系统中文字体，无外部字体下载。没有额外动画或阴影层叠。没有照片的文章使用文字封面；不给虚构旅行手记添加真实旅行照片。

| 版本 | 布局与字体 | 核心色板 | 适合 |
| --- | --- | --- | --- |
| A 发现（默认） | 左导航，桌面四列、宽屏五列、手机双列；无衬线字；紧凑标题与作者 | 白 #FFFFFF、墨 #242424、灰 #696969、浅灰 #F5F5F5、红 #DF2945 | 混合图文与日常浏览，最贴合当前定位 |
| B 杂志 | 桌面三列，较宽封面，摘要可见；标题使用系统宋体回退 | 暖白 #FBFAF7、墨 #242424、灰 #696969、米灰 #F0EEEA、绿 #4B6555 | 论文解读、旅行手记、长文 |
| C 极简 | 桌面双列条目、手机单列；小封面与标题摘要并排 | 白 #FFFFFF、墨 #242424、灰 #696969、浅灰 #F2F2F2、线 #EDEDED | 高频扫读新闻与技术内容 |

草图：

```text
A: 左导航 | 搜索 / 风格 | 分类 | [封面][封面][封面][封面]
B: 左导航 | 搜索 / 风格 | 标题与分类 | [宽封面+摘要] × 3
C: 左导航 | 搜索 / 风格 | 分类 | [小封面 标题摘要] × 2
```

A 作为默认，因为平台不是只有论文的阅读器。B、C 用于对比；界面右上角切换，并将 style 写入 URL，可直接用 ?style=journal 或 ?style=minimal 打开。无效值回退默认。主题筛选和收藏状态不会因切换而丢失。

## 预览与验证

运行 `node scripts/export-preview.mjs`，会从本地发布数据库导出同一份真实内容快照：

- outputs/newsroom-preview.html：默认 A，支持切换全部版本。
- outputs/newsroom-discover.html：A。
- outputs/newsroom-journal.html：B。
- outputs/newsroom-minimal.html：C。

这些文件是离线快照，不能代替线上发布服务。当前只有五篇内容，列表按最新发布排列，无虚构热度或排名。

现有测试运行 `node --test --experimental-test-isolation=none`；页面用 Chrome 桌面 1440px 和手机 390px 检查。浏览器功能检查包括切换风格、搜索、收藏、来源筛选、详情及横向溢出。

验证结果：现有 65 项测试通过；Chrome 1440px 和嵌入式实际 390px 视口分别通过 25 项断言（共 50 项）。其中包含真实内容数量、三版切换、横向溢出、搜索、详情开关、来源筛选与收藏。未进行线上部署。
