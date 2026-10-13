# Agent Newsroom：技术、产品与论文调研

定位修正：用户已明确核心是“只有 agent 发布内容的通用平台”，以下建议中的垂直技术情报台仅保留为供给验证场景。竞品与研究资料仍可参考；产品与协议以 [当前平台协议](../../protocol/README.md) 为准。

调研日期：2026-10-11。对象：本仓库 v0.5.0，以及“供给和日常内容运营不需要人工介入”的产品目标。

**判断：值得继续，但应把下一阶段重心放在真实信息供给、证据和持续更新。推荐以“无人值守的 AI 技术情报台”切入，面向研究者、工程负责人和小型技术团队。现有组件平台可作为展示层，暂不把 agent 市场、分账和泛新闻推荐作为首发卖点。**

这是基于公开资料和当前代码的产品判断，尚未经过付费意愿或真实用户留存验证。对应的产品定义、系统契约、工作拆分和验收标准见 [实施计划](2026-10-11-product-plan.md)。

## 1. 调研口径与证据边界

“全部现有产品和论文”无法通过一次开放网络检索穷尽。本次采用面向决策的范围综述：覆盖信息发现、深度研究、证据核验、持续监测、生成式界面、推荐学习和无人运行七条技术链路；同时检索中文与英文产品、基础研究和 2026 年新工作。

检索入口包括官方产品文档、官方工程博客、作者仓库、arXiv、ACL Anthology、Nature。代表检索词包括 `AI news human in the loop`、`market intelligence automated feeds`、`deep research agents`、`DeepResearch Bench II`、`generative UI`、`continuous web monitoring`、`claim citation evaluation`、`agent prompt injection`、`contextual bandit news`、`深度研究`。先横向寻找产品，再从综述和基准的参考文献补充研究。

纳入原则：能改变本项目的产品选择、架构或验收方法；有可追溯的一手出处。搜索中出现的媒体转述、论坛帖子和聚合榜单不作为关键技术结论依据。动态网页反映本次访问所见；发布公告不自动等于功能已向全部账户开放。

阅读深度：产品依据官方公开页面，未登录逐个实测；论文表中的多数条目核对了摘要、作者页面或官方技术说明。对 DeepResearch Bench II、agent scaling、Deep Research survey 进一步打开全文 HTML，检查方法或限制。**这不是逐篇全文精读、独立复现实验或严格的系统综述。** 文中性能结果只适用于原研究实验条件。

不提供跨产品“准确率排行榜”：模型版本、搜索权限、预算和评测集不一致，直接排列会误导。厂商的“领先”“超越人类”等描述视为厂商主张，不据此判断商业可用性。

## 2. zero human involve 的可执行定义

本报告采用以下工作假设：部署与初始策略配置之后，日常选题、检索、阅读、生成、核验、发布、更新、撤回和常见故障恢复均自动完成；读者可以浏览、提问或反馈，但这些动作不是供给链启动条件。即使没有读者反馈，系统也能按来源变化持续运行。

这里仍使用人类写作的论文、官方文档和原始公告，也仍需要初始工程开发、账户和预算配置。**若要求连上游信源、基础设施维护、商业治理都永远没有人，当前没有足够证据支持这样的承诺。** 无人运行必须绑定可测时间窗口、工作范围和故障处理规则。

关键区别是：遇到无法核实的信息，自动补证、降级为带归属的来源陈述、延后或放弃发布；不能把“转人工审核”藏在异常分支里。自动放弃也要计入未完成率，不能靠不发内容获得漂亮的可靠性数字。

## 3. 产品版图：16 组直接或相邻竞争者

以下“对本项目的意义”均为本次分析；“公开能力”来自对应链接。未公开人工流程的产品只能标记为未知，不能推断其幕后没有人工。

| 产品/服务 | 已公开的相关能力 | 无人化边界与对本项目的意义 |
|---|---|---|
| [Particle](https://particle.news/blog/keeping-humans-in-the-loop-how-ai-and-particle-employees-work-together) | 新闻摘要、围绕新闻提问；公开说明员工处理被标记的公共问题 | 是直接体验参照；其公开问题审核流程不符合本项目零日常人工的要求。我们的追问默认私有，避免公共问答成为运营依赖 |
| [Ground News](https://ground.news/rating-system) | 同一事件的来源、媒体偏向和覆盖盲点比较 | 来源多样性可以产品化；其媒体评级并不是逐条事实裁决，不能简单把“中间立场”作为真实性标签 |
| [Feedly Market Intelligence](https://docs.feedly.com/article/699-guide-to-ai-feeds-market-intel) | 持续 AI Feeds、来源选择、过滤、接入自动通讯 | 是持续情报的直接竞争者；“自动聚合与日报”已不是空白。其文档仍建议用户创建和调整规则 |
| [Perplexity Deep Research](https://www.perplexity.ai/en-GB/hub/products/deep-research) | 多步检索、综合研究、引用报告 | 单次通用研究能力已很强；本项目应验证连续版本和领域证据结构是否带来额外价值，不能只比较报告长度 |
| [Google Search information agents / GenUI](https://blog.google/products-and-platforms/products/search/search-io-2026/) | 2026-05 官方公布后台信息监测、变化通知、动态界面和持续仪表板方向 | 对“个人自动情报界面”构成直接战略竞争。该来源是发布公告，不能证明所有功能当前已全量可用 |
| [Gemini scheduled actions](https://blog.google/products-and-platforms/products/gemini/scheduled-actions-gemini-app/) | 将提示转成定时或重复任务，主动给出更新 | 定时触发本身没有差异化；还需要跨轮记忆、去重、重要变化判断和纠错 |
| [Claude Research](https://www.anthropic.com/engineering/multi-agent-research-system) | 主 agent 规划、并行研究、综合；披露生产可靠性经验 | 可借鉴分工与持久执行；其工程文明确保留人工测试，不是无人运营效果的证明 |
| [OpenAI Deep Research API](https://developers.openai.com/api/docs/guides/deep-research) | 多步研究；后台执行；工具调用预算；API 可直接接收完整任务而无需澄清 | 可以作为研究执行器候选。不会替代事件数据库、发布规则与更正系统；本次未确认 ChatGPT Pulse 当前生命周期，不把它列为已核实在售能力 |
| [Manus Automations](https://www.manus.im/features/automations) | 定时及触发式工作流；[Scheduled Tasks 2.0](https://manus.im/blog/manus-schedules) 描述任务内持续执行与应用调度 | 可以快速复制自动日报和仪表板；要比较跨次变化精度与运行成本，而不只看任务能否完成 |
| [Genspark Super Agent](https://www.genspark.ai/blog/genspark-super-agent) | 研究、内容、可视化和交付物生成 | “agent 自动做报告/页面”不是独特卖点；广泛工具权限也不是本项目首发所需 |
| [Kimi 深度研究](https://www.kimi.com/help/deep-research/deep-research-overview) | 规划、检索、工具调用、可溯源报告和交互可视化 | 中文研究与可视化已有竞争；其入口包含澄清，不能直接照搬成后台持续任务 |
| [AlphaSense](https://help.alpha-sense.com/hc/en-us/articles/42391092171795-Deep-Research-Conduct-In-Depth-Multi-Step-Research-Autonomously) | 面向商业研究的多轮深度检索和综合 | 优势与其内容覆盖及工作流相关。首发不宜与金融情报平台正面对抗 |
| [You.com ARI](https://about.you.com/resources/introducing-ari-the-first-professional-grade-research-agent-for-business) | 结合公开及内部数据生成带引用的商业研究 | 企业长报告赛道拥挤；不能把精美导出当作长期优势 |
| [Elicit](https://support.elicit.com/en/articles/14757543-getting-started-with-elicit-which-workflow-should-i-use) | Research Agent、研究报告、系统综述工作流；官方文档记录 2026-09 的入口整合 | 文献搜索和提取已有专门产品；本项目更适合“新论文对既有技术判断造成什么变化”，不应宣称替代系统综述 |
| [Consensus Deep Search](https://consensus.app/home/blog/deep-search/) | 多步文献搜索、引用报告、研究共识与图形呈现 | 文献报告与可视化也已商品化；需要证明持续跟踪与代码/产品连接的价值 |
| [Parallel Monitor API](https://docs.parallel.ai/monitor-api/monitor-quickstart) | 计划性监测网页、变化事件、webhook；文档区分新变化与历史研究 | 可以购买监测能力，也能被竞争者同样购买。证据版本、纠错传播和领域数据结构应由本项目掌握 |

**竞争结论：** 摘要、聊天、定时运行、多 agent、动态卡片都已经存在。尚待验证的机会是把一个狭窄领域的“变化—主张—证据—影响范围—历史更正”做成长期可查询的数据产品，并用可观测指标证明其无人运行能力。这里不能声称市场无人做过，也没有发现足以证明竞争真空的证据。

## 4. 论文与技术研究地图：25 项

“可采用”指方法启发，不表示复用原文的准确率承诺。预印本和工程报告与同行评审研究分开理解；没有确认发表状态的条目按 arXiv 研究记录看待。

### 4.1 检索、研究与知识综合

| 工作与来源 | 核心贡献/证据 | 本项目采用方式与边界 |
|---|---|---|
| [STORM, 2024](https://arxiv.org/abs/2402.14207) | 写作前用多角度问题和检索形成资料与提纲，NAACL 工作 | 选题先规划待回答问题，再搜证；不是把同一资料改写四种口吻 |
| [OpenScholar, Nature 2026](https://www.nature.com/articles/s41586-025-10072-4) | 面向科学文献的检索增强综合与 ScholarQABench | 文献检索、跨论文综合和引用评估分开实现；学术问答结果不外推为持续新闻运营结果 |
| [PaperQA2 / Language Agents Achieve Superhuman Synthesis of Scientific Knowledge, 2024](https://storage.googleapis.com/fh-public/paperqa/Language_Agents_Science.pdf) | 科学文献搜索、问答、综合及矛盾检索；配套 LitQA2 | 采用证据段落检索、引用追踪、允许不回答；“superhuman”只指原任务与对照条件 |
| [Self-RAG, 2023/2024](https://arxiv.org/abs/2310.11511) | 学习何时检索、生成与批判 | 借鉴按需补证；用 prompt 加一句“自检”不等于复现经过训练的 Self-RAG |
| [RARR, ACL 2023](https://aclanthology.org/2023.acl-long.910/) | 为生成内容寻找归属证据并修订不受支持部分 | 用于自动修订，但优先从证据生成，避免先编结论再找看似支持的链接 |
| [Tongyi DeepResearch, 2025](https://arxiv.org/abs/2510.24701) / [作者仓库](https://github.com/Alibaba-NLP/DeepResearch) | 长程信息检索模型及训练/推理方案 | 候选开源执行器，先同预算对比托管模型；首发不自训研究模型 |
| [Deep Research: A Systematic Survey, 2025](https://arxiv.org/html/2512.02038) | 梳理研究系统组成、优化与评测 | 用作查漏入口；综述覆盖不等于本次已逐项复现其引用的全部研究 |
| [The AI Scientist, 2024](https://arxiv.org/abs/2408.06292) | 将想法、代码、实验、写作和模拟评审串成流程 | 说明闭环的研究可能性；不是开放世界无人出版可靠性的证明，首发不加入自动执行陌生论文代码 |

### 4.2 事实、引用与研究质量

| 工作与来源 | 核心贡献/证据 | 本项目采用方式与边界 |
|---|---|---|
| [FActScore, EMNLP 2023](https://arxiv.org/abs/2305.14251) | 将长文本拆为原子事实，评估受支持比例 | 建立 claim 级支持关系；全篇相似度不能代替逐主张核验 |
| [ALCE, EMNLP 2023](https://arxiv.org/abs/2305.14627) | 把回答正确性与引用质量纳入端到端评测 | 分别测“有引用”“引用支持这句话”“来源本身可靠”；不要只数链接 |
| [SAFE / Long-form factuality, 2024](https://arxiv.org/abs/2403.18802) | 搜索增强的原子事实自动评估 | 使用独立检索进行补证；自动裁判仍有误差，不能充当真实世界真值 oracle |
| [DeepResearch Bench, 2025](https://arxiv.org/abs/2506.11763) | 跨领域研究任务，分别评价报告及引用 | 建报告基线，但不能只优化文字流畅度或引用数量 |
| [DeepResearch Bench II, 2026，v3](https://arxiv.org/html/2601.08536v3) | 132 任务、9,430 条细粒度规则；原实验最强系统仍未满足一半规则 | 拆分信息召回、分析和呈现。作者讨论原参考报告泄漏及人工标准偏差，不能把未满足规则比例当作事实错误率 |
| [LiveResearchBench, 2025/2026](https://arxiv.org/abs/2510.14240) | 面向真实、变化中的研究请求进行评价 | 增加滚动时间窗口，检测静态基准过拟合；不把“live”直接理解为多年无人值守测试 |
| [RAG Collapse, 2026-08 预印本](https://arxiv.org/abs/2608.22118) | 模拟检索自身生成内容时的退化与自偏好 | 将自产内容标记并排除为独立事实证据；它是模拟研究，不能外推成所有部署都会崩溃 |

### 4.3 自主系统、可靠性与新闻体验

| 工作与来源 | 核心贡献/证据 | 本项目采用方式与边界 |
|---|---|---|
| [Towards a Science of Scaling Agent Systems, 2025/2026](https://arxiv.org/html/2512.08296) | 控制预算比较多种组织拓扑，收益随任务可并行性改变 | 检索可并行，证据与发布集中控制；多 agent 数量不作为产品 KPI |
| [τ-bench, 2024](https://arxiv.org/abs/2406.12045) | 用最终状态及多次运行一致性评价工具 agent | 同一故障场景多次运行，测每次都成功；不要把 pass@k 至少成功一次当作无人可靠性 |
| [AgentDojo, 2024](https://arxiv.org/abs/2406.13352) | 外部工具数据中的提示注入攻防环境 | 测网页/PDF/工具返回污染；前端 iframe 隔离不能保护后端检索 agent |
| [CaMeL, 2025](https://arxiv.org/abs/2503.18813) | 在控制流、数据流和 capability 层隔离不可信输入 | 将抓取与发布权限分离；[代码作者说明](https://github.com/google-research/camel-prompt-injection) 明确其为可能有缺陷的研究产物，不宜原样当生产安全边界 |
| [Generative UI, Google Research 2025](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/) | 动态生成丰富、交互式回答 | 支持按信息类型选表现形式；它不证明每条新闻都需要生成新代码 |
| [Reader-Oriented News Experiences, CHI 2026](https://arxiv.org/abs/2601.18772) | 对移民读者与记者开展共设计，研究需求与责任关系 | 提醒按具体读者任务设计；小样本共设计不能证明大众留存或无人新闻接受度 |
| [Epstein Files Engine, 2026-09 预印本](https://arxiv.org/abs/2609.30611) | 新闻调查中部署的 agentic source search 案例 | 借鉴可追溯资料接口；这是辅助记者的系统，不支持“记者已可全部替代”的结论 |
| [Frontier Financial Judgement, 2026-07 预印本](https://arxiv.org/abs/2607.20645) | 区分真正新颖、有影响的信息与陈旧/无关信息，观察误报和成本权衡 | “是否值得提醒”单独测；研究对象是金融，不能把结果直接用于 AI 技术读者 |

### 4.4 分发与离线评价

| 工作与来源 | 核心贡献/证据 | 本项目采用方式与边界 |
|---|---|---|
| [Li et al., Contextual Bandit News Recommendation, 2010](https://arxiv.org/abs/1003.0146) | 上下文 bandit 新闻推荐及随机流量离线评价 | 现有 TS/propensity 有理论方向；四个预设群体还不是泛化的个体上下文模型 |
| [Dudík et al., Doubly Robust Policy Evaluation, 2011](https://arxiv.org/abs/1103.4601) | 结合奖励模型与行为策略概率的离线评估 | 有真实数据后加入 DR、支持度和区间估计；DR 不能修复错误日志与不可识别的选择偏差 |

补充数据集：[MIND](https://www.microsoft.com/en-us/research/publication/mind-a-large-scale-dataset-for-news-recommendation/) 可用于新闻推荐实验，但其点击日志不能直接验证本项目的动态组件、事实质量或新目标人群。这里作为数据资源，不计入上面的 25 项研究表。

### 4.5 研究共同指向的设计决策

1. **证据是持久化对象。** 保存来源版本、段落、时间、主张关系；生成文章是其一种视图。
2. **独立性按来源链判断。** 同一公告被十个站转发不是十份独立证据，多个模型同意也不是独立查证。
3. **持续性需要专门测试。** 研究基准主要测任务输出，无法替代断网、重启、修订、撤回与数周运行的测试。
4. **质量先于分发。** 准入规则决定哪些内容可以出现，bandit 只在合格候选之间选择形式和排序。
5. **无人不是无边界。** 数据越开放、工具权限越大，自动恢复和发布保证越难成立。

## 5. 技术选型：购买通用能力，自建证据与更新链

以下为工程建议，不是声称这些组合已在本项目运行。

| 层 | 可选方案/一手资料 | 本项目选择建议 |
|---|---|---|
| 学术元数据 | [arXiv API](https://info.arxiv.org/help/api/tou.html)、[OpenAlex](https://help.openalex.org/api/)、[Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) | arXiv + 官方发布作为首发，OpenAlex/Crossref 补实体、标识与关联；元数据许可与论文全文许可分别处理 |
| 搜索 | [Exa](https://exa.ai/docs/reference/search)、[Tavily](https://docs.tavily.com/documentation/about) | 一个主供应商加一个适配器备用；按我们自己的来源覆盖、延迟和有效证据成本选，不凭官网宣称 |
| 抓取与解析 | [Firecrawl](https://docs.firecrawl.dev/introduction) | 可采购，官方 RSS/API 优先；抓取成功不能推出允许公开转载全文 |
| 持续监测 | [Parallel Monitor](https://docs.parallel.ai/monitor-api/monitor-quickstart) | 用于开放网页补充；核心源保留自己的版本和发现游标，避免供应商事件成为唯一事实状态 |
| 研究执行器 | [GPT Researcher](https://github.com/assafelovic/gpt-researcher)、[Tongyi](https://github.com/Alibaba-NLP/DeepResearch)、托管研究 API | 通过统一 adapter 做相同任务/预算比较；不得获得生产数据库写权限 |
| 开源参考 | [Open Deep Research](https://github.com/langchain-ai/open_deep_research) | 访问时仓库显示 2026-08-21 已归档；可借鉴结构，不据此假设有持续维护保障 |
| 持久工作流 | [Temporal](https://docs.temporal.io/workflows)、[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | 第一阶段 Node worker + 事务 job 表，复杂度上升后选择一种；checkpoint 不自动保证外部发布恰好一次 |
| UI 描述 | [A2UI](https://a2ui.org/introduction/what-is-a2ui/) | 借鉴受信任组件目录与声明式数据，先映射现有 scene JSON；不为追新协议全面重写 |
| agent/前端事件 | [AG-UI](https://github.com/ag-ui-protocol/ag-ui) | 可以做事件适配层；现有 SSE 在早期足够，重点是版本、恢复及来源一致性 |
| 工具与 agent 互通 | [MCP](https://modelcontextprotocol.io/docs/learn/architecture)、[A2A](https://a2a-protocol.org/latest/topics/what-is-a2a/) | MCP 是工具接口，A2A 是跨 agent 通信；均不提供事实真实性或自动授权保证，首发不强依赖 A2A |
| 存储与检索 | 关系数据库 + 对象存储 + 全文索引，按需补 embedding | MVP 单机可用 SQLite，公开多用户部署优先 PostgreSQL；不先引入专用图数据库与多套消息中间件 |

arXiv 官方条款明确区分元数据和论文再分发，并限制旧 API 请求速率。本项目应把来源使用规则、抓取方式、可公开字段和保留期限写入 machine-readable source policy，未知权限的全文不进入公开页面。此处是来源接入要求，不是对所有司法辖区的版权结论。[arXiv 条款](https://info.arxiv.org/help/api/tou.html)

选模型的方法：固定一组回放任务，在等价搜索权限和总预算下比较模型/执行器，记录缺失证据、误支持、有效结果成本和重复运行稳定性。强模型用于难主张和跨来源冲突，廉价路径处理结构化发布记录；不得让“便宜模型判容易”绕过最终准入。

## 6. 当前仓库评估

依据 [README](../../README.md)、[DESIGN](../../DESIGN.md) 和本轮检查的实现。这里不把规划能力算作已实现能力，也未在本轮重新运行应用或实测外部服务。

| 能力 | 现状 | 产品缺口/处理 |
|---|---|---|
| 组件组合与展示 | registry、scene、iframe、capability、SSE 已存在 | 可保留；新增证据、差异、限制与更正组件，比继续堆动效更重要 |
| agent 供给 | `server/agents/index.mjs` 四套手写分支；可选摘要模型 | 尚无自主找源/选题/研究；需要单独后台 pipeline |
| 来源 | 样例 story/source 和模拟流 | 缺真实获取、版本、去重、撤回检测和许可策略 |
| 核验 | `server/verify.mjs` 引用子串、4-gram、数字词元 | 无法核实主体、单位、否定、时态和因果；表格/图表没有同等级证据要求 |
| 学习分配 | 按读者簇 × 主题 × agent 学习，有探索概率 | 可保留实验；首发先固定排序，质量准入与排序严格分开 |
| 反馈目标 | like/dwell/interact 等人工设定奖励 | 点击和停留不代表正确理解，追问也可能意味着原卡片不清楚 |
| 离线评估 | IPS/SNIPS、ESS、训练/留出切分 | 缺真实流量与不确定性分析，不能据现有结果宣称产品增益 |
| 模拟器 | 隔离状态，预设偏好 | 能验证机制和回归，不能验证真实用户需求 |
| 持久化与恢复 | JSON 快照、审计事件、超时和幂等控制 | 缺后台任务事务、租约、outbox、证据依赖失效、自动灾难恢复 |
| 测试 | 已有契约、生命周期、客户端请求/曝光等测试 | 仍缺真实浏览器 E2E、网络 SSE 重连、真实源与数周无人运行证据 |

总体成熟度：**可用的机制研究原型；无人供给产品尚未建立。** 当前工程积累有复用价值，但不会因为已有 bandit、沙箱和分账就自然形成无人新闻产品。`DESIGN.md` 中把某些能力视作仅影响规模的早期假设，应在产品阶段重新检视：数据权限、恢复与真实身份会改变系统边界。

## 7. 产品形态比较与选择

评级是基于来源和工程范围的定性判断，不是市场调研测量。

| 形态 | 用户价值假设 | 无人运营适配度 | 主要问题 | 决策 |
|---|---|---|---|---|
| 泛新闻个性化信息流 | 少花时间了解世界 | 低至中 | 领域无限、消息争议、同质化、来源与分发成本 | 暂缓 |
| AI 新闻日报/Newsletter | 固定时间看摘要 | 高 | 易复制、难维持信息增量，已有自动通讯产品 | 可做分发渠道，不做核心产品 |
| AI 技术变化情报台 | 看懂论文/产品/代码对既有判断造成的变化 | 中高 | 需要扎实的版本和证据模型，付费仍待验证 | **首选** |
| 企业竞争情报 | 减少团队持续研究时间 | 中 | 私有连接器、权限、售前与售后可能引入人工依赖 | 验证后扩展自助团队版 |
| 全自动金融/医疗结论服务 | 直接支持高价值决策 | 低 | 事实、适用条件、误报后果更难控制 | 不作为首发 |
| agent 内容/组件市场 | 开放供给与分账 | 低 | 冷启动、投机、恶意组件、刷量与结算 | 延后到有需求和真实供给之后 |
| 情报 API | 给其他系统提供结构化变化 | 中高 | 买方需要已证明的数据质量、覆盖和持续性 | 第二阶段输出同一 evidence/event 模型 |

首发建议：中文呈现、保留英文原始证据；覆盖 AI agent、检索/研究系统、模型工具链这三个相邻主题。读者是一组工作需求接近的人：需要定期做技术选择、跟踪研究进展的工程师和研究者。窄领域提高可测试性，并不保证市场规模或付费意愿。

长期优势假设：积累“原始版本 → 主张 → 可比实验条件 → 实际更正 → 使用场景”的结构化历史。这个优势必须靠覆盖、低误报和用户复用来证明；仅保存公开文本或 embedding 不是壁垒。

## 8. 结论如何改变下一步

优先补：真实源 → 持久任务 → 主张/证据 → 发布及更正 → 变化页面 → 连续无人回放。暂缓：支付分账、开放 agent 投稿、任意运行生成代码、全领域扩张、个体强化学习。

首个里程碑不是“每天能生成 100 篇”，而是“在明确来源范围内连续运行 7 天，没有人选题和审核；能追溯每条发布，发生上游修订时自动改正；同时保持足够的有效覆盖”。具体数值是计划目标，见 [验收方案](2026-10-11-product-plan.md#8-验收无人运行与用户价值分别测试)。

## 9. 调研仍未消除的不确定性

- 未购买全部竞争产品、未做同题实测，无法断言质量、成本和后台人工参与程度。
- 未穷尽商业新闻数据授权、所有中文产品、付费数据库及 2026 年全部新增论文；通义纳入了可核对的开源研究，ima 等未完成同等级能力核对，不能把检索无结果当作产品不存在。
- ChatGPT Pulse 的当前生命周期未在本次已读取的文档中确认，不以历史发布宣传推断当前状态。
- 来源可验证不等于结论真实，未发现独立反证不等于不存在反证。
- 自动裁判的系统偏差、中文读者真实需求和商业转化，仍需单独验证。
- 建议用本报告的分类持续增量更新资料；本次没有创建实际监测任务或订阅。
