---
title: "Claude Code / Codex 上下文管理机制调研报告"
date: 2026-04-10
created_at: 2026-04-10
last_modified_at: 2026-04-10
description: "从上下文分层、压缩管线、缓存、Memory 和 Subagent 机制出发，梳理 Claude Code / Codex 的上下文管理设计及其对自研 coding agent 的启发。"
categories: ["LLM Systems"]
tags: ["Claude Code", "Codex", "Context Engineering", "Agent", "Prompt Cache"]
thumbnail: assets/claude-code-context-cover.jpg
hero_image: assets/claude-code-context-cover.jpg
body_class: claude-code-context-article
read_time: "24 min read"
published: true
---

> 面向外部分享版本  
> 主题：Claude Code 的上下文生命周期、压缩管线、缓存影响、Subagent、Memory 与动态上下文注入机制  
> 更新时间：2026-04-10

---

## 0. 摘要

Claude Code 的上下文管理不是一个简单的“历史对话 + 自动总结”功能，而是一套围绕 **有限 context window** 设计的 agent runtime。它把上下文当成稀缺运行内存，把文件系统、memory、transcript、tool result persistence、skills、MCP、hooks、subagents 当成外部存储和控制平面，然后在每次模型调用前动态决定“哪些信息值得进入当前推理窗口”。

可以用一句话概括：

> **Claude Code 通过“动态组装上下文 → 工具输出限流与持久化 → 低成本历史清理 → 结构折叠 → 语义压缩 → 外部记忆与子代理隔离”的组合，维持长任务中的连续性、成本和模型注意力质量。**

本文把相关机制分成九个部分：

1. 上下文总体心智模型
2. 上下文来源与分层
3. 五层压缩管线
4. Budget Reduction、Snip、Microcompact 的触发与信息损失
5. Auto-compact、summary 与 prompt cache 的关系
6. Memory / CLAUDE.md 的加载与重建机制
7. Subagent 的调度策略与 Claude Code / Codex 差异
8. 时间感知、hidden context、system reminder 的动态注入
9. 对自研 coding agent 的工程启发

资料口径说明：本文主要基于 Claude Code / Claude API / Codex 官方文档，以及一篇公开源码分析论文。对于 Claude Code 内部源码细节，本文只讨论公开分析中已经描述的架构行为，不引用泄露源码原文。部分实现细节可能随 Claude Code 版本、feature flag、运行环境变化而变化。

---

## 1. 为什么 context engineering 是 coding agent 的核心问题

传统聊天机器人可以把上下文近似看成“历史消息列表”。但 coding agent 不一样。一次任务中会产生大量高噪声信息：文件读取、grep 结果、bash 输出、测试日志、stack trace、diff、工具错误、hook 反馈、MCP 工具结果、subagent 返回等。

Anthropic 在 context engineering 文章里把 context 定义为模型采样时实际收到的 token 集合，并强调 agent 的 context 是每轮动态变化、需要持续筛选的资源，而不只是 prompt 文本本身。它还明确提到，长 horizon agent 需要 compaction、structured note-taking、multi-agent architecture 等手段来维持连续性。[^anthropic-context-engineering]

所以 Claude Code 的目标不是“尽可能塞满 context window”，而是同时优化三件事：

| 目标 | 含义 |
|---|---|
| 相关性 | 当前任务最需要的信息要进入窗口 |
| 连续性 | 长任务不能因为压缩丢掉关键状态 |
| 成本与性能 | 降低输入 token、提高 prompt cache 命中、减少上下文污染 |

一个更准确的心智模型是：

```text
文件系统 / memory / transcript / MCP / skills / hooks / subagents
                     ↓
             Context assembler
                     ↓
      当前模型调用的 projected context view
                     ↓
         模型推理 → 工具调用 → 新事件进入 runtime
                     ↓
       budget reduction / snip / microcompact / collapse / compact
```

**关键点：底层历史可以 append-only 保存，但每次发给模型的上下文视图不一定 append-only。**

---

## 2. Claude Code 的上下文分层

Claude Code 官方 prompt caching 文档把请求前缀分成三层：system prompt、project context、conversation。每次请求都会重新发送完整上下文；模型本身不在请求之间保存状态，prompt caching 通过精确 prefix match 复用已处理过的前缀。[^cc-prompt-caching]

### 2.1 三层主结构

| 层级 | 内容 | 变化时机 | 缓存影响 |
|---|---|---|---|
| System prompt layer | 核心行为规则、工具定义、output style | 工具定义变化、Claude Code 升级等 | 变化会导致后续全部 prefix 失效 |
| Project context layer | `CLAUDE.md`、auto memory、unscoped rules | session start、`/clear`、`/compact` 后重载 | 内容变化会导致 project context 之后失效 |
| Conversation layer | 用户消息、Claude 回复、tool results、system reminders | 每轮追加 | 正常 append 对缓存友好，compact 会重建这一层 |

这里一个常见误解是：**CLAUDE.md 和 auto memory 不是 system prompt layer。** 官方文档明确说 CLAUDE.md 内容作为 user message 交给 Claude，而不是强制性的 system 配置；如果要硬性阻止行为，应使用 settings 或 PreToolUse hook。[^cc-memory]

### 2.2 启动时自动进入上下文的内容

Claude Code context window 文档说明，在用户输入前，`CLAUDE.md`、auto memory、MCP tool names、skill descriptions 等会加载进 context；随着 Claude 工作，文件读取、path-scoped rules、hook 结果会继续增加上下文。[^cc-context-window]

启动内容大致包括：

```text
System prompt / tool definitions / output style
CLAUDE.md hierarchy
Auto memory: MEMORY.md 前 200 行或 25KB
MCP tool names / server instructions
Skill names / descriptions
当前工作目录、平台、shell、部分环境信息
```

### 2.3 动态进入上下文的内容

任务运行中，以下内容会按需进入：

```text
Read / Grep / Bash / Edit 等工具调用与结果
文件变化 system reminder
hooks additionalContext
MCP resource / tool result
skill body
subagent result summary
/compact summary
```

这使 Claude Code 更像一个“上下文操作系统”：稳定指令、动态状态、外部存储、工具 I/O、压缩视图被拆开管理，而不是拼成一个巨大的 prompt。

---

## 3. 上下文生命周期

一次较长任务的上下文生命周期可以抽象为：

```text
阶段 A：启动
  加载 system prompt、CLAUDE.md、auto memory、MCP tool names、skill descriptions

阶段 B：执行
  用户输入 → 模型推理 → 工具调用 → 工具结果进入 context

阶段 C：膨胀
  文件读取、搜索结果、测试日志、diff、hook context 持续增加 token

阶段 D：轻量整形
  限制大工具输出、清理旧工具结果、移除低价值历史碎片

阶段 E：结构折叠
  对过长历史生成 projected view，但不一定破坏底层 transcript

阶段 F：语义压缩
  接近阈值时生成 structured summary，替换旧历史，保留最近尾部消息

阶段 G：重建当前视图
  重新注入稳定 project context、summary、recent tail、仍有效的 runtime state

阶段 H：异常恢复
  prompt too long 或 near capacity 时走 reactive compact / overflow recovery
```

官方 context window 文档也明确建议：在上下文填满前，可以用 `/compact focus on ...` 指定压缩重点；切换无关任务时用 `/clear`；大规模读取交给 subagent 以避免污染主上下文。[^cc-context-window]

---

## 4. 五层压缩管线：从便宜清理到语义总结

公开源码分析论文把 Claude Code 的 pre-model context shapers 概括为五层：Budget reduction、Snip、Microcompact、Context collapse、Auto-compact。前几层更偏确定性或启发式，最后一层才是完整模型摘要。[^arxiv-five-layer]

| 层级 | 策略 | 主要对象 | 成本 | 是否依赖 LLM judge |
|---|---|---|---|---|
| 1 | Budget Reduction | 单个超大 tool result | 很低 | 否 |
| 2 | Snip | 旧历史片段、低价值结构噪声 | 低 | 否，主要启发式 |
| 3 | Microcompact | 旧工具结果、缓存压力、时间路径 | 低到中 | 否，主要规则/阈值 |
| 4 | Context Collapse | 过长历史的 projected view | 中 | 通常不是 LLM judge |
| 5 | Auto-compact | 接近窗口阈值的完整历史 | 高 | 触发靠规则；summary 生成靠模型 |
| 兜底 | Reactive Compact | prompt-too-long / near capacity | 高 | 恢复阶段可能用模型 |

需要注意：**五层管线不是五次总结。** 前几层大多是确定性清理、引用化、视图投影；真正的语义 summary 主要发生在 auto-compact。

---

## 5. Budget Reduction：大输出外部化，而不是让大结果淹没窗口

Budget Reduction 处理的是单个工具结果过大的情况，例如：

```text
Read 一个几万行文件
Bash 输出大量日志
Grep 返回海量匹配
MCP 工具返回完整数据库 schema
测试输出巨大 stack trace
```

公开源码分析称，Budget Reduction 会对 tool result 施加 per-message size limit，并把超大输出替换成 content reference；替换内容会持久化，以便 resume 或后续查询重建。[^arxiv-five-layer]

Claude Code 官方 changelog 也提到，超过 50K characters 的 tool results 会被持久化到磁盘，以减少 context window 使用并延长会话寿命；较早版本还提到“大型 bash/tool outputs 被保存到磁盘而非截断，Claude 可通过文件引用访问完整输出”。[^cc-changelog]

因此它不是单纯裁剪，而更接近：

```text
原始大输出：保存到外部存储
active context：保留 preview + file reference + metadata
后续需要：Claude 读取引用文件，或重新执行工具
```

但这不等于“模型已经理解了完整输出”。模型只看到了预览和引用；如果后续推理需要完整内容，它必须显式读取引用文件，或者重新运行工具。

| 场景 | 恢复方式 |
|---|---|
| 大文件读取 | 重新 Read 原文件或读取持久化引用 |
| 大 grep/search 结果 | 读取引用或重新搜索 |
| 大 bash/test 输出 | 读取持久化日志；必要时重跑命令 |
| 非确定性外部结果 | 更依赖持久化，因为重跑可能不同 |
| 重要结论 | 应写入 summary / memory / TODO，而不是只依赖大输出引用 |

工程上，Budget Reduction 是 **原始数据外部化**，不是 **语义保真压缩**。

---

## 6. Snip：如何判断“无价值历史碎片”

Snip 容易被误解成“让 LLM 判断哪些历史不重要”。更准确地说，它大概率是结构性、时间深度驱动的启发式清理。

公开源码分析称 Snip 是 lightweight trim，会移除 older history segments，并返回 `messages / tokensFreed / boundaryMessage`；它处理的是 temporal depth，而不是对每段文本做语义审判。[^arxiv-five-layer]

### 6.1 Snip 更像垃圾回收

容易被清理的内容通常包括：

```text
很旧的中间状态
重复 progress marker
空消息 / 僵尸消息 / 孤儿 tool_result
已经被 summary 覆盖的旧历史片段
旧的工具结果 placeholder
过期的 runtime marker
被后续事实覆盖的临时观察
```

通常会被保护的内容包括：

```text
当前用户请求
最近若干轮消息
未完成 tool_use / tool_result 对
最新工具结果
compact summary / boundary
当前任务 TODO / plan
显式用户约束
正在执行的操作状态
```

### 6.2 为什么不适合 LLM judge

让 LLM 判断每段历史是否有价值，会引入额外模型调用、延迟、成本和不确定性，而且判断本身也要消耗上下文。Snip 的价值恰恰是便宜、频繁、确定。

所以它更像：

```text
if old_enough
  and outside_recent_tail
  and structurally_safe
  and not protected_by_boundary
  and tokens_freed_is_worthwhile:
      snip_or_replace_with_boundary()
```

而不是：

```text
if LLM_says_low_value(message):
    delete(message)
```

风险在于：**结构上低价值，不代表语义上一定低价值。** 例如用户早期说过“不要改 public API”“必须兼容 Python 3.9”，这些话可能很早，但很关键。长期规则应该进入 `CLAUDE.md`、auto memory、plan/TODO，而不是只留在早期聊天里。

---

## 7. Microcompact：旧工具结果清理与 cache-aware trade-off

Microcompact 主要处理“工具结果已经不值得原样留在 active context”的情况。比如 Claude 曾经 grep 过、读过文件、跑过测试，这些结果未来可重新获取，因此不一定要长期占据上下文。

Anthropic API 的 context editing 文档提供了一个相似机制：`clear_tool_uses_20250919` 会在上下文超过阈值时清理最旧的 tool results，用 placeholder 告诉 Claude 结果已被移除，并支持 `trigger`、`keep`、`clear_at_least`、`exclude_tools` 等参数。[^anthropic-context-editing]

这说明该类机制的触发主要是规则/阈值，而不是 LLM judge：

| 参数/因素 | 作用 |
|---|---|
| `trigger` | 超过多少 input tokens 或 tool uses 后开始清理 |
| `keep` | 保留最近多少个 tool use/result 对 |
| `clear_at_least` | 至少释放多少 token，否则不值得破坏 cache |
| `exclude_tools` | 指定某些工具结果永不清理 |
| cache pressure | 清理会打断 prefix cache，因此必须权衡收益 |

核心 trade-off：

```text
不清理：每轮携带大量旧工具结果，cache read 成本和上下文污染持续存在
清理：当前破坏某个 prefix 点之后的 cache，但释放大量 token，后续请求更短
```

所以 Microcompact 的本质不是“无脑删旧结果”，而是 **可重算信息的 cache-aware 外部化/占位化**。

---

## 8. Context Collapse：读时投影，而不是破坏历史

Context Collapse 是一个更结构化的策略：它不一定直接修改底层 REPL / transcript 历史，而是在模型查询时把 `messagesForQuery` 替换成折叠后的 projected view。公开源码分析把它描述为 read-time projection：模型看到的是折叠版，完整历史仍可用于重建。[^arxiv-five-layer]

这解决了一个重要矛盾：

```text
审计 / resume / fork：需要完整 append-only transcript
模型推理：不应该每次都看完整历史
```

因此底层可以保存全量事件流，但模型输入可以是：

```text
compact boundary
+ summary
+ recent tail
+ active attachments
+ runtime state reminders
```

这比“截断旧消息”更接近操作系统里的虚拟内存视图。

---

## 9. Auto-compact：模型生成结构化交接摘要

Auto-compact 是真正的语义压缩。Claude API compaction 文档描述的流程是：当输入 token 超过配置阈值时，API 生成当前对话 summary，创建 `compaction` block，并在后续请求中从 summary 继续；默认 trigger 是 150,000 tokens，且必须至少 50,000 tokens。[^anthropic-compaction]

Claude Code 的 `/compact` 类似：用 structured summary 替换旧 conversation history，同时大部分启动内容会自动重新加载。官方 context window 文档列出了 compaction 后各类内容的去留：system prompt/output style 不变，project-root `CLAUDE.md` 和 auto memory 会重注入，path-scoped rules 和 nested `CLAUDE.md` 要等再次读取匹配文件才回来，skill bodies 会在预算内重注入。[^cc-context-window]

### 9.1 Summary 应保留什么

高质量 summary 不应只是聊天摘要，而应该像任务交接文档：

```text
用户真实目标
当前任务状态
已修改内容
关键文件和路径
架构决策
未解决 bug
失败测试和错误信息
下一步计划
不能重复踩的坑
用户明确约束
最近重要上下文
```

Anthropic 的 context engineering 文章也说，Claude Code 的 compaction 会保留架构决策、未解决 bug 和实现细节，同时丢弃冗余工具输出或消息。[^anthropic-context-engineering]

### 9.2 Summary 使用哪个模型

Claude API compaction 文档明确说：summary 使用请求中指定的同一个模型，没有选项改用另一个更便宜的模型。它还提示，在有 tools 的请求中，内部 summarization step 偶尔可能调用工具而不是写 summary，因此可以通过自定义 instructions 明确要求“不要调用工具，只输出文本”。[^anthropic-compaction]

所以它不是：

```text
主模型 → 第三方小模型总结 → 主模型继续
```

而更像：

```text
当前模型 + 同一段历史 + summarize instruction → structured summary
```

### 9.3 接近 maxLen 时的风险

如果等到窗口几乎耗尽再 compact，会有风险：

```text
没有足够输出预算写 summary
输入过长导致请求失败
summary 过度抽象或遗漏细节
工具环境下 summary 失败
```

所以更稳的策略是在任务边界主动压缩，或用 `/compact focus on ...` 指定保留重点，而不是完全依赖自动压缩。

---

## 10. Prompt cache：为什么压缩会破坏部分缓存，但仍然值得

Claude Code 每轮请求都发送完整上下文；prompt cache 通过精确 prefix match 复用已处理前缀。官方文档强调：prefix 中任何变化都会导致变化点之后重算，没有 per-file 或 per-segment caching。[^cc-prompt-caching]

### 10.1 正常 append-only 对缓存友好

```text
Turn 1: [system][project][m1]
Turn 2: [system][project][m1][m2]
Turn 3: [system][project][m1][m2][m3]
```

前缀稳定，所以 cache 命中高。

### 10.2 Compact 会重建 conversation layer

```text
Compact 前:
[system][project][m1][m2][m3]...[mN]

Compact 后:
[system][project][summary][recent_tail][runtime_state]
```

这不再是旧 conversation prefix，因此 conversation layer cache 会失效。但 system prompt layer 通常仍可复用；project context 如果 `CLAUDE.md` / memory 没变，也可以继续命中。官方文档明确说，`/compact` 会替换 message history，使 conversation layer 失效；system 层会复用，project context 会从磁盘重载，只有内容没变时才 cache-hit。[^cc-prompt-caching]

### 10.3 Compact 不是无脑增加成本

Auto-compact 的经济账是：

| 阶段 | 成本 |
|---|---|
| compact 当轮 | 额外一次 summary 采样；可能有 cache write 成本 |
| compact 后 | 上下文变短，每轮 input/cache read 成本下降 |
| 长任务总体 | 降低 prompt-too-long 风险和 context rot |

Claude API 文档也说明 compaction 是额外 sampling step，会计入 rate limits 和 billing；一次请求中可能先有 compaction iteration，再有正常 message iteration。[^anthropic-compaction]

因此更准确的判断是：**compact 是一次性换缓存，用更短的新历史替代越来越臃肿的旧历史。** 它牺牲短期缓存连续性，换长期成本和注意力质量。

---

## 11. Memory / CLAUDE.md：半稳定 project context，不是 system prompt

Claude Code 有两类跨会话记忆：

| 机制 | 谁写 | 内容 | 加载方式 |
|---|---|---|---|
| `CLAUDE.md` | 用户/团队/组织 | 规则、约定、项目背景 | session start 加载；目录层级和懒加载 |
| Auto memory | Claude | 从用户纠正和偏好中积累的 notes | `MEMORY.md` 前 200 行或 25KB 每次会话加载，topic files 按需读取 |

官方 memory 文档说明：auto memory 的 `MEMORY.md` 是 memory 目录入口，前 200 行或 25KB 会在每次 conversation 开始时加载；详细 topic files 不在启动时加载。[^cc-memory]

### 11.1 Memory 修改是否导致 system prompt cache 大面积失效？

不会直接导致 system prompt layer 失效，因为 memory 属于 project context layer，不是 system prompt layer。

更准确的过程是：

```text
启动 session：
  [system][project context: memory v1][conversation]

运行中 Claude 写 memory：
  磁盘 memory 变成 v2
  当前已加载 context 仍是 v1
  本轮不会 retroactively 改 prefix

之后 /compact、/clear、restart：
  重新加载 memory v2
  system prompt 仍可命中
  project context 从变化点后可能重建
  conversation layer 因 compact 被 summary 替换
```

官方 prompt caching 文档也说：编辑 project-root 和 user-level `CLAUDE.md` mid-session 不会使缓存失效，但新内容也不会生效；新内容要等下一次 `/clear`、`/compact` 或 restart 才加载。[^cc-prompt-caching]

### 11.2 Memory 的工程建议

```text
稳定、长期、每次都需要的规则 → CLAUDE.md
Claude 从经验中学到的偏好/洞察 → auto memory
详细笔记 → topic files，按需读取
当前任务状态 → TODO / plan / handoff
短期动态事实 → hook reminder，带 as_of/ttl
```

不要把频繁变化的大量状态写入启动加载的 `MEMORY.md`，否则会增加 project context 成本并影响 cache。

---

## 12. Subagent：把大规模探索隔离在主上下文之外

Subagent 是 Claude Code 里非常关键的 context isolation 机制。官方文档说：当一个 side task 会把大量 search results、logs、file contents 塞进主对话，而主对话后续不需要反复引用这些原始内容时，应该使用 subagent；subagent 在自己的 context window 中工作，只返回 summary。[^cc-subagents]

### 12.1 Claude Code：默认模型自主调度，用户可强干预

Claude Code 会根据 subagent 的 `description` 决定何时委派任务。内置 subagents 包括 Explore、Plan、General-purpose。Explore 是快速 read-only agent，使用 Haiku，适合文件发现、代码搜索、代码库探索；Plan 用于 plan mode 的代码库研究；General-purpose 适合复杂多步任务和代码修改。[^cc-subagents]

控制权可以分成三层：

```text
用户层：明确要求使用某个 subagent，或 @ mention / agent setting
配置层：description、tool 权限、model、permissionMode、memory、hooks 等
模型层：Claude 根据任务和 description 决定是否委派、如何写 delegation prompt
```

默认建议：

| 场景 | 策略 |
|---|---|
| 大规模代码搜索 / repo 理解 | 让 Claude 自主用 Explore，或显式要求用 Explore |
| 并行审查安全、性能、测试 | 用户显式指定多个 subagents |
| 需要 read-only 保证 | 显式指定 read-only subagent |
| 小范围改一个函数 | 不用 subagent |
| 子任务需要大量主上下文背景 | 考虑 fork，而不是普通 isolated subagent |

### 12.2 Isolated subagent vs fork

普通 subagent 每次从 fresh isolated context 开始，不看主对话历史、已读文件或已 invoked skills；Claude 会写 delegation message 给它。例外是 fork：fork 会继承父会话完整历史、system prompt、tools、model，适合“重新解释背景太贵”的 side task。[^cc-subagents]

```text
普通 subagent：
  省主上下文，隔离性强，但需要重新交代背景

fork subagent：
  共享背景，启动顺，但隔离性弱
```

### 12.3 Codex：必须显式触发 subagent

Codex 的设计与 Claude Code 不同。OpenAI Codex 文档明确说：Codex 只在用户明确要求时 spawn subagents；它不会自动开子代理。用户需要直接说“spawn two agents”“delegate this work in parallel”“use one agent per point”等。[^codex-subagents]

Codex subagent workflow 适合并行的 read-heavy 任务，例如探索、测试、triage、summarization；对于多个 agent 同时改代码的 write-heavy 工作流要谨慎，因为容易产生冲突和协调成本。[^codex-subagent-concepts]

| 维度 | Claude Code | Codex |
|---|---|---|
| subagent 是否自动触发 | 会，Claude 根据 description 自主判断 | 不会，必须用户显式要求 |
| 用户最佳姿势 | 写好 subagent description；关键任务显式指定 | 明确说明 spawn 几个、各自做什么、怎么汇总 |
| 主要价值 | 隔离探索噪声、权限/模型定制 | 并行探索、并行审查、并行任务拆分 |
| 成本 | subagent 有独立 context 和 cache | 每个 subagent 都做自己的模型/工具工作，token 更多 |

---

## 13. 动态时间感知与 hidden context

用户常观察到 Claude Code 或 Codex 在执行任务时能感知时间变化。更准确的解释是：**模型没有持续走动的内部时钟，而是 agent runtime 在模型调用边界注入了时间和环境状态。**

### 13.1 Claude Code 的时间/环境注入

公开源码分析提到 Claude Code 有 `currentDate` 之类的 user context，以及 git status 等 system context；官方 hooks 文档则说明 hook 的 `additionalContext` 会被包装成 system reminder 插入 conversation，Claude 在下一次模型请求时读取。[^arxiv-cache-dynamic][^cc-hooks]

典型来源包括：

```text
currentDate / timezone / cwd / shell 等启动或 turn context
UserPromptSubmit hook 注入当前时间、branch、issue、CI 状态
Bash `date` 或日志时间戳
skill dynamic context injection，例如 !`git diff HEAD`
file-changed system reminder
PostToolUse / PostToolBatch hook 追加工具执行后的环境事实
```

### 13.2 Codex 的环境 context

Codex 官方 subagent 文档不把 environment context 作为重点，但 OpenAI Codex GitHub 讨论和 rollout 文件示例显示，Codex session logs 中可以看到 `turn_context` / `environment_context` 一类信息，包含 current date、timezone、cwd、sandbox/approval policy 等。官方维护者也建议通过 `~/.codex/sessions/.../rollout-*.jsonl` 查看实际注入内容。[^codex-rollout-discussion]

### 13.3 Hidden context 会过期，必须显式管理新鲜度

Claude Code hooks 文档特别提醒：mid-session 注入的 system reminder 会保存进 transcript；resume 时旧文本会被重放，而不是重新运行过去的 hook，因此 timestamps、commit SHA 这类值会 stale。SessionStart hooks 在 resume 时会重新运行，可用于刷新上下文。[^cc-hooks]

因此动态 hidden context 应该带元数据：

```text
as_of: 2026-06-09T10:15:00+09:00
source: ci_status_api
ttl: 10m
refresh: run `ci status --branch ...`
scope: current_branch_only
```

不推荐：

```text
CI 失败了。
```

推荐：

```text
<context name="ci_status" as_of="2026-06-09T10:15:00+09:00" ttl="10m">
当前 CI main 分支失败，失败 job 是 integration-tests。
如果当前时间超过 ttl，先重新查询 CI，不要直接相信本段。
</context>
```

---

## 14. MCP、Skills、Hooks：上下文控制平面

Claude Code 的上下文管理不只靠 compact，还大量依赖扩展机制的设计。

### 14.1 MCP Tool Search：工具 schema 延迟加载

Claude Code MCP 文档说，Tool Search 默认启用：session start 只加载工具名和 server instructions，具体 tool definitions 延迟到 Claude 需要时再发现和加载；只有实际使用的工具进入 context。也可以用 threshold mode，在 tool schemas 能放入 context window 10% 以内时 upfront load，超出部分 defer。[^cc-mcp]

这解决的是“工具说明本身污染上下文”的问题。

```text
不好的做法：把所有 MCP tool schema 全塞进 system prompt
更好的做法：只塞 tool names + server instructions，按需搜索工具定义
```

MCP 大输出也有预算机制：默认最大 25,000 tokens，超过阈值会警告；超过默认 persist-to-disk 阈值的结果会保存到磁盘，并在 conversation 中替换为 file reference。MCP server 作者还可以用 `_meta["anthropic/maxResultSizeChars"]` 提高特定工具的阈值。[^cc-mcp]

### 14.2 Skills：description 常驻，body 按需加载

Claude Code skills 文档说，普通 session 中 skill descriptions 会加载进 context，让 Claude 知道有哪些技能；完整 skill content 只有在 invoked 时加载。大量参考资料应放入 supporting files，需要时再读取。[^cc-skills]

```text
skill name / description：作为路由索引，低成本常驻
SKILL.md body：触发时进入 conversation
reference.md / examples.md：按需读取
script：执行，不一定加载全文
```

Skill descriptions 也有预算：所有 skill names 总是包含，但 descriptions 会按预算裁剪；预算大约按模型 context window 的 1% 扩展，溢出时较少使用的 skill descriptions 先被丢。[^cc-skills]

### 14.3 Skills 也能注入动态状态

Skills 支持动态上下文注入，例如在 `SKILL.md` 中写：

```md
## Current changes
!`git diff HEAD`
```

Claude Code 会先执行命令，把输出替换进 skill 内容，再让 Claude 看到最终 prompt。[^cc-skills]

这也是“模型感知当前变化”的重要来源之一。

### 14.4 Hooks：注入、替换、阻止上下文流动

Hooks 是更底层的控制平面。官方文档说明：

- `additionalContext` 会被包装成 system reminder 注入上下文；
- `PostToolUse` 可以用 `updatedToolOutput` 替换工具输出，让 Claude 看到清洗后的结果；
- `PreCompact` 可以阻止 compaction；
- `PostCompact` 可以拿到 `compact_summary` 做外部同步。[^cc-hooks]

这意味着 agent runtime 不必让所有工具结果原样进入模型，而可以在工具输出进入 context 前进行：

```text
脱敏
压缩
替换
增加约束说明
阻止危险操作
保存外部日志
```

---

## 15. Compaction 后哪些内容保留，哪些会丢

官方 context window 文档对 compaction 后状态给了明确说明。[^cc-context-window]

| 内容 | Compaction 后状态 |
|---|---|
| System prompt / output style | 不变，不属于 message history |
| Project-root `CLAUDE.md` / unscoped rules | 从磁盘重新注入 |
| Auto memory | 从磁盘重新注入 |
| Path-scoped rules | 丢失，直到再次读取匹配文件 |
| Nested `CLAUDE.md` | 丢失，直到读取对应目录文件 |
| Invoked skill bodies | 预算内重注入，单 skill 5,000 tokens，总 25,000 tokens，旧的可能被丢 |
| Hooks 代码本身 | 不属于 context；hook 在事件发生时运行 |
| 旧工具结果 | 可能被摘要、清除、引用化或丢弃 |
| 最近 tail messages | 通常完整保留，用来维持近期操作连续性 |

这解释了为什么长期规则要放在稳定加载位置：

```text
必须长期有效 → project-root CLAUDE.md / unscoped rule / auto memory
只对部分路径有效 → path-scoped rule，但要接受 compact 后延迟恢复
复杂流程 → skill，而不是 CLAUDE.md 长篇 procedure
动态状态 → hook reminder + TTL
```

---

## 16. 风险与失败模式

### 16.1 压缩一定有损

Auto-compact 是语义摘要，可能丢掉早期微妙约束、用户偏好、失败路径细节。官方 compaction 文档也列出限制：summary 使用同一模型；有 tools 时可能 summary 失败；compaction 是额外 sampling step，会增加计费和 rate limit 压力。[^anthropic-compaction]

### 16.2 Snip / Microcompact 可能误删语义关键但结构很旧的信息

启发式清理无法保证知道“用户第一轮说过的那句话十轮后仍然关键”。关键约束应被提升到 memory、CLAUDE.md、plan 或 compact focus。

### 16.3 Hidden context 会过期

时间、branch、commit SHA、CI 状态、feature flag 这类动态事实如果被长期保留在 transcript 中，就会变成污染源。必须带 `as_of`、`ttl`、`source`、`refresh`，或通过 hook 每轮刷新。

### 16.4 Subagent 隔离可能造成全局不一致

Subagent 减少主上下文污染，但普通 subagent 默认不继承完整主对话；它可能缺少全局约束。对于必须共享大量背景的任务，fork 更合适，但隔离性较弱。

### 16.5 Prompt cache 与上下文质量存在 trade-off

为了保持 prefix cache，不应该永远维护巨大 append-only prompt。压缩会让 conversation cache 断一次，但长期能降低上下文污染和每轮成本。

---

## 17. 对自研 coding agent 的工程启发

如果要设计自己的 coding agent，可以从 Claude Code 中抽象出以下原则。

### 17.1 上下文不是 prompt，而是 runtime resource

不要只做：

```text
system prompt + history + summarizer
```

而应该做：

```text
stable instruction layer
project context layer
conversation layer
runtime reminder layer
external memory layer
tool result store
subagent context store
projected model view
```

### 17.2 稳定内容和动态内容分开

| 内容类型 | 推荐放置 |
|---|---|
| 长期规则 | root memory / project instruction |
| 项目事实 | CLAUDE.md / AGENTS.md adapter |
| 当前任务状态 | TODO / plan / handoff |
| 动态时间状态 | hook reminder with TTL |
| 大工具输出 | 持久化 + preview + pointer |
| 复杂流程 | skill / command |
| 大规模探索 | subagent |

### 17.3 先便宜清理，再 LLM 总结

推荐管线：

```text
单工具结果限流 / 持久化
→ 结构性垃圾回收
→ 旧工具结果清理
→ read-time projection
→ 模型 summary
→ prompt-too-long recovery
```

### 17.4 大输出必须可引用、可重取、可验证

对每个被持久化的大输出，至少保留：

```text
tool name
arguments
timestamp
cwd / git commit
preview head/tail
file reference
content length
是否可重跑
```

### 17.5 Subagent 用于隔离污染，不只是并行加速

最适合 subagent 的任务：

```text
repo-wide search
large log analysis
multi-file dependency analysis
parallel code review
read-only research
方案比较
```

不适合：

```text
小改动
高频交互
强共享上下文任务
多个 agent 同时改同一片代码
```

### 17.6 Hidden context 要带 freshness contract

动态 system reminder 必须说明：

```text
这是什么
什么时候生成
什么时候过期
来自哪里
如何刷新
旧版本是否被新版本 supersede
```

否则它迟早会变成上下文污染源。

### 17.7 Prompt cache 可观测化

至少监控：

```text
cache_read_input_tokens
cache_creation_input_tokens
input_tokens after compaction
original_input_tokens before editing
compact frequency
tool result persistence count
subagent result token size
```

这样才能判断某次 compact / microcompact 是省钱还是制造 cache churn。

---

## 18. 最终结论

Claude Code 的上下文管理值得关注的不是某个 prompt，也不是某个 `/compact` 命令，而是它把上下文变成了 agent runtime 的一等公民。

它的核心设计可以浓缩为：

```text
1. 动态组装 context，而不是静态大 prompt
2. 稳定指令、项目记忆、会话历史、动态状态分层管理
3. 大工具输出先外部化，active context 只保留 pointer/preview
4. 旧工具结果和低价值历史用启发式清理
5. 长历史用 projected view 折叠，而不是破坏底层 transcript
6. 接近阈值时才用模型生成 structured summary
7. compact 后重新构建当前视图，并重注入稳定 project context
8. 用 subagent 隔离大规模探索噪声
9. 用 hooks、MCP Tool Search、skills 控制上下文流入
10. 用 prompt cache 分层设计降低重复处理成本
```

这套架构最像一个小型操作系统：

```text
context window = 运行内存
file system / memory / transcript = 外部存储
prompt cache = 前缀缓存
snip / microcompact = 垃圾回收
context collapse = 虚拟视图
compact summary = checkpoint / handoff
subagent = 子进程
hooks = 中断与策略控制面
```

对于自研 agent 来说，真正应该学习的是这套分层工程思想：**不要指望模型自己“记住一切”，而是设计一个能持续筛选、刷新、引用、压缩、隔离和重建上下文的 runtime。**

---

## 参考来源

[^anthropic-context-engineering]: Anthropic Engineering, “Effective context engineering for AI agents”, 2025-09-29. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

[^cc-context-window]: Claude Code Docs, “Explore the context window”. https://code.claude.com/docs/en/context-window

[^cc-prompt-caching]: Claude Code Docs, “How Claude Code uses prompt caching”. https://code.claude.com/docs/en/prompt-caching

[^cc-memory]: Claude Code Docs, “How Claude remembers your project”. https://code.claude.com/docs/en/memory

[^cc-subagents]: Claude Code Docs, “Create custom subagents”. https://code.claude.com/docs/en/sub-agents

[^cc-hooks]: Claude Code Docs, “Hooks reference”. https://code.claude.com/docs/en/hooks

[^cc-mcp]: Claude Code Docs, “Connect Claude Code to tools via MCP”. https://code.claude.com/docs/en/mcp

[^cc-skills]: Claude Code Docs, “Extend Claude with skills”. https://code.claude.com/docs/en/skills

[^cc-changelog]: Claude Code Docs, “Claude Code changelog”. https://code.claude.com/docs/en/changelog

[^anthropic-context-editing]: Claude API Docs, “Context editing”. https://platform.claude.com/docs/en/build-with-claude/context-editing

[^anthropic-compaction]: Claude API Docs, “Compaction”. https://platform.claude.com/docs/en/build-with-claude/compaction

[^arxiv-five-layer]: Jiacheng Liu et al., “Dive into Claude Code: The Design Space of Today’s and Future AI Agent Systems”, arXiv:2604.14228v1, 2026-04-14. https://arxiv.org/html/2604.14228v1

[^arxiv-cache-dynamic]: 同上，关于 `getSystemContext()`、`getUserContext()` memoization、动态变化和 feature flag 的分析。https://arxiv.org/html/2604.14228v1

[^codex-subagents]: OpenAI Developers, “Subagents – Codex”. https://developers.openai.com/codex/subagents

[^codex-subagent-concepts]: OpenAI Developers, “Subagents – Codex Concepts”. https://developers.openai.com/codex/concepts/subagents

[^codex-rollout-discussion]: OpenAI Codex GitHub Discussion, “What's pulled into context when a new session starts?” https://github.com/openai/codex/discussions/12668
