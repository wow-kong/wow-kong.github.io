---
title: "GRPO 算法介绍：从组内相对优势到 LLM 后训练实践"
date: 2025-05-10
created_at: 2025-05-10
last_modified_at: 2025-05-10
description: "系统梳理 GRPO 的动机、目标函数、token 级更新机制、相对 PPO 的差异，以及在 LLM 后训练中的适用边界与实践流程。"
categories: ["LLM Alignment"]
tags: ["LLM", "GRPO", "Reinforcement Learning", "Post-training", "RLHF"]
thumbnail: assets/grpo-algorithm-cover.png
hero_image: assets/grpo-algorithm-cover.png
hero_image_layout:
body_class:
read_time: "18 min read"
published: true
---

> 这是一份面向 LLM 后训练实践的 GRPO 技术文档，重点梳理它为什么省掉 critic、如何计算组内相对优势、token 级更新如何发生，以及上线训练时该关注哪些风险。

# 0. 摘要

GRPO，全称 **Group Relative Policy Optimization**，可以理解为一种面向大语言模型后训练的强化学习算法。它的核心思想是：

> 对同一个 prompt 生成多条回答，分别打分，然后在同组内部比较谁更好；比组内平均更好的回答被强化，比组内平均更差的回答被削弱。

它和 PPO 一样使用 **advantage（相对优势）** 来指导策略模型更新，也保留了 PPO 风格的 **policy ratio clipping** 和 **KL 约束** 来控制更新幅度。但与 PPO 最大的不同是：

- **PPO** 通常需要训练一个 critic / value model，用来估计每个状态的预期收益。
- **GRPO** 不再额外训练 critic，而是用同一个 prompt 下多条回答的组内平均 reward 作为 baseline。

因此，GRPO 可以省掉 value model 带来的显存和计算开销，特别适合数学、代码、格式遵循等可以自动打分或半自动打分的任务。但它也有明显局限：它主要获得的是**轨迹级别**的优劣信号，通常无法准确判断一条回答内部哪个 token 或哪个推理步骤真正立功或背锅。

# 1. 背景：为什么需要 GRPO？

大语言模型训练通常可以粗略分成三个阶段：

```text
预训练 Pre-training
    ↓
监督微调 SFT
    ↓
偏好对齐 / 强化学习后训练 RL Post-training
```

SFT 让模型学会模仿高质量答案，但它主要解决的是“会不会这样答”。如果我们想让模型在多个可能答案中更偏向某种目标，例如：

- 数学答案更正确；
- 代码更容易通过测试；
- 回复更符合格式要求；
- 推理更充分；
- 不确定时更谨慎；
- 风格更简洁、清晰、专业；

就需要一种机制告诉模型：

```text
哪些回答更好，应该更常生成；
哪些回答更差，应该更少生成。
```

这就是强化学习后训练要解决的问题。

传统 RLHF 中常用 PPO。PPO 效果强，但成本较高，因为它通常需要训练额外的 critic / value model。DeepSeekMath 论文提出 GRPO，目的之一就是去掉 critic，用组内 reward 估计 baseline，从而降低训练资源消耗。

# 2. 强化学习视角下的大语言模型

在语言模型中，可以这样对应强化学习概念：

| 强化学习概念 | LLM 中的对应物 |
|---|---|
| state \(s_t\) | prompt + 当前已经生成的前缀 |
| action \(a_t\) | 下一个 token |
| policy \(\pi_\theta\) | 当前语言模型 |
| trajectory \(o\) | 一整条模型回复 |
| reward \(r\) | 对整条回复或中间步骤的评分 |
| advantage \(A\) | 相比某个 baseline 更好或更差的程度 |

假设给定问题 \(q\)，模型生成回答：

$$
o=(o_1,o_2,\dots,o_T)
$$

语言模型生成整条回答的概率为：

$$
\pi_\theta(o\mid q)=\prod_{t=1}^{T}\pi_\theta(o_t\mid q,o_{<t})
$$

取 log 后：

$$
\log \pi_\theta(o\mid q)
=
\sum_{t=1}^{T}
\log \pi_\theta(o_t\mid q,o_{<t})
$$

这条公式非常关键。它说明：

> 提高一整条回答的生成概率，本质上就是提高这条回答中每个 token 在对应上下文下的生成概率。

因此，即使 reward 只在整条回答结束后给出，它也可以通过 \(\log \pi_\theta(o_t\mid q,o_{<t})\) 影响每个 token 的梯度。

# 3. PPO 的核心：用 critic 估计“预期收益”

PPO 的核心更新信号是 advantage。直觉上：

```text
advantage = 实际表现 - 原本预期
```

在 PPO 中，critic / value model 负责估计当前状态的价值：

$$
V_\psi(s_t)
$$

其中：

$$
s_t=(q,o_{<t})
$$

也就是：

> 在当前前缀下继续生成，未来大概能拿多少 reward？

PPO 中的 advantage 通常可理解为：

$$
A_t \approx R_t - V_\psi(s_t)
$$

实际实现中常用 GAE（Generalized Advantage Estimation）：

$$
\delta_t = r_t + \gamma V_\psi(s_{t+1}) - V_\psi(s_t)
$$

$$
\hat A_t^{\text{GAE}}
=
\sum_{l=0}^{\infty}(\gamma\lambda)^l\delta_{t+l}
$$

critic 的作用不是直接判断“这个 token 是否正确”，而是提供一个 baseline：

```text
如果实际结果比 critic 预期更好：advantage 为正，增强该动作；
如果实际结果比 critic 预期更差：advantage 为负，削弱该动作。
```

这种设计可以降低 policy gradient 的方差，并给不同位置提供更细粒度的训练信号。但代价是：critic 本身也是一个大模型，需要训练、占显存、会带来额外不稳定性。如果 critic 估值不准，反而可能给 actor 提供错误信号。

# 4. GRPO 的核心思想：用“组内平均”替代 critic

GRPO 省掉 critic。它不再问：

```text
critic 认为这个状态未来能得多少分？
```

而是问：

```text
同一个 prompt 下，这条回答比其他回答更好吗？
```

具体做法是：对同一个问题 \(q\)，从旧策略模型 \(\pi_{\theta_{old}}\) 采样 \(G\) 条回答：

$$
\{o_1,o_2,\dots,o_G\}
$$

每条回答得到一个 reward：

$$
r_i = R(q,o_i)
$$

然后计算组内均值：

$$
\mu_q = \frac{1}{G}\sum_{i=1}^{G}r_i
$$

和组内标准差：

$$
\sigma_q = \sqrt{\frac{1}{G}\sum_{i=1}^{G}(r_i-\mu_q)^2}
$$

第 \(i\) 条回答的 advantage 为：

$$
\hat A_i = \frac{r_i-\mu_q}{\sigma_q+\epsilon}
$$

其中 \(\epsilon\) 是一个很小的数，用来避免除零。

这就是 “Group Relative” 的含义：

```text
不是看绝对分数，
而是看它相对同组平均水平高多少。
```

如果：

$$
\hat A_i > 0
$$

说明第 \(i\) 条回答比同组平均更好，应被强化。

如果：

$$
\hat A_i < 0
$$

说明第 \(i\) 条回答比同组平均更差，应被削弱。

# 5. GRPO 的完整目标函数

GRPO 继承了 PPO 的 clipped surrogate objective。对第 \(i\) 条回答中的第 \(t\) 个 token，定义 policy ratio：

$$
\rho_{i,t}(\theta)
=
\frac{
\pi_\theta(o_{i,t}\mid q,o_{i,<t})
}{
\pi_{\theta_{old}}(o_{i,t}\mid q,o_{i,<t})
}
$$

含义是：

```text
新模型生成这个 token 的概率 / 旧模型生成这个 token 的概率
```

如果 \(\rho_{i,t}>1\)，说明新模型比旧模型更倾向于生成该 token。  
如果 \(\rho_{i,t}<1\)，说明新模型比旧模型更不倾向于生成该 token。

GRPO 的 token 级目标项为：

$$
\min
\left(
\rho_{i,t}(\theta)\hat A_{i,t},
\text{clip}(\rho_{i,t}(\theta),1-\varepsilon,1+\varepsilon)\hat A_{i,t}
\right)
$$

再加 KL 惩罚：

$$
-\beta D_{KL}(\pi_\theta || \pi_{ref})
$$

最终目标可以写成：

$$
J_{GRPO}(\theta)
=
\mathbb E
\left[
\frac{1}{G}
\sum_{i=1}^{G}
\frac{1}{|o_i|}
\sum_{t=1}^{|o_i|}
\left\{
\min
\left(
\rho_{i,t}\hat A_{i,t},
\text{clip}(\rho_{i,t},1-\varepsilon,1+\varepsilon)\hat A_{i,t}
\right)
-
\beta D_{KL}(\pi_\theta || \pi_{ref})
\right\}
\right]
$$

实际训练中通常最小化 loss：

$$
L_{GRPO}(\theta)=-J_{GRPO}(\theta)
$$

其中：

- \(\pi_\theta\)：当前正在训练的 policy model；
- \(\pi_{\theta_{old}}\)：生成 rollout 时的旧 policy model；
- \(\pi_{ref}\)：reference model，常为 SFT 后的初始模型或阶段性 reference；
- \(\varepsilon\)：clip 范围；
- \(\beta\)：KL 惩罚系数；
- \(\hat A_{i,t}\)：第 \(i\) 条回答第 \(t\) 个 token 的 advantage。

在 outcome-level GRPO 中，一条回答通常只有一个最终 reward，因此这条回答里的所有 token 共享同一个回答级 advantage：

$$
\hat A_{i,t}=\hat A_i
$$

# 6. 最终 reward 如何反馈到每个 token？

最基础的 policy gradient 可以写成：

$$
\nabla_\theta J(\theta)
=
\mathbb E
\left[
R(q,o)\nabla_\theta \log \pi_\theta(o\mid q)
\right]
$$

代入 token 分解：

$$
\nabla_\theta J(\theta)
=
\mathbb E
\left[
R(q,o)
\sum_{t=1}^{T}
\nabla_\theta \log \pi_\theta(o_t\mid q,o_{<t})
\right]
$$

使用 advantage 后：

$$
\nabla_\theta J(\theta)
\approx
\mathbb E
\left[
\sum_{t=1}^{T}
\hat A
\nabla_\theta \log \pi_\theta(o_t\mid q,o_{<t})
\right]
$$

所以，最终 reward 并不是被直接“反传”到 token。reward 本身可以是不可导的，比如：

```text
数学答案是否正确：0 / 1
代码是否通过测试：0 / 1
JSON 是否合法：0 / 1
```

它只作为一个权重，乘在 token 的 log probability 梯度上。

如果 \(\hat A>0\)：

```text
提高这些 token 在各自上下文中出现的概率。
```

如果 \(\hat A<0\)：

```text
降低这些 token 在各自上下文中出现的概率。
```

# 7. Advantage 如何变成“概率提升幅度”？

advantage 不是直接变成一个固定的概率增量。不是：

```text
A = 0.8，所以概率 +0.8
```

而是：

```text
A = 0.8，所以这次 token 的 log-prob 梯度被乘以 0.8。
```

简化 loss：

$$
L=-\hat A\log p_y
$$

其中：

$$
p_y=\pi_\theta(y\mid s)
$$

对于目标 token 的 logit \(z_y\)，可以得到直觉：

$$
\Delta z_y \propto \eta \hat A(1-p_y)
$$

其中 \(\eta\) 是学习率。

这说明：

- \(|\hat A|\) 越大，更新倾向越强；
- 当前 token 概率 \(p_y\) 越低，提升空间越大；
- 当前 token 概率已经很高时，继续提升空间变小；
- 最终概率变化还受到 optimizer、learning rate、clip、KL、batch 中其他梯度等因素影响。

因此，在一条回答中，虽然所有 token 可能共享同一个 advantage，但它们的概率不会等幅度变化。

# 8. GRPO 与 PPO 的关键区别

| 维度 | PPO | GRPO |
|---|---|---|
| 核心更新信号 | advantage | advantage |
| baseline 来源 | critic / value model | 同 prompt 多条回答的组内平均 reward |
| 是否需要 critic | 通常需要 | 不需要 |
| 是否需要同 prompt 多采样 | 不一定 | 通常需要 |
| advantage 粒度 | 可以是 state/token 级 | outcome-level 下通常是回答级，广播到 token |
| 成本结构 | 训练 critic 成本高 | rollout 采样成本高 |
| 优势 | 更细粒度、更可能样本高效 | 实现简单、省显存、适合可验证任务 |
| 风险 | critic 不准会带偏 | 组内全坏时可能鼓励“相对没那么坏”的坏轨迹 |

可以用一句话概括：

```text
PPO 用 critic 换掉“同题多采样”；
GRPO 用“同题多采样”换掉 critic。
```

# 9. 一个具体例子

假设同一道题：

```text
3 + 2 = ?
```

模型采样 4 个回答：

```text
回答 1：3 + 2 = 5，reward = 1
回答 2：3 + 2 = 6，reward = 0
回答 3：答案是 5，reward = 1
回答 4：答案是 4，reward = 0
```

组内平均：

$$
\mu=0.5
$$

标准差：

$$
\sigma=0.5
$$

于是：

$$
A_1=\frac{1-0.5}{0.5}=1
$$

$$
A_2=\frac{0-0.5}{0.5}=-1
$$

$$
A_3=1
$$

$$
A_4=-1
$$

于是：

```text
回答 1、3 的 token 被整体正向强化；
回答 2、4 的 token 被整体负向削弱。
```

这也暴露了 GRPO 的局限：

```text
“3 + 2 = 6” 中，真正错的是 “6”；
但 outcome-level GRPO 会把整条回答都当作低 reward 轨迹处理。
```

这就是 credit assignment problem，即信用分配问题。

# 10. GRPO 为什么能工作？

虽然 GRPO 的 credit assignment 比较粗，但它仍然能在很多任务上有效，主要原因是统计效应。

GRPO 并不真正知道：

```text
某个 token 本身是好还是坏。
```

它学到的是：

```text
在某个上下文下，哪些 token / 片段 / 推理模式经常出现在高 reward 轨迹中。
```

例如，在大量样本中：

```text
“先分析条件 → 列公式 → 计算 → 检查答案”
```

经常出现在高 reward 轨迹中，而：

```text
“直接猜答案”
```

经常出现在低 reward 轨迹中，那么模型就会逐渐增强前一种模式，削弱后一种模式。

因此，GRPO 首先强化的不是“单个 token 的绝对正确性”，而是：

> 更容易导向高 reward 的生成模式。

这也是为什么在推理模型训练中，最终正确性 reward 有时也能诱导出自检、反思、重新验证等行为：不是因为这些词本身被单独奖励，而是因为包含这些行为的轨迹更容易拿到高 reward。

# 11. GRPO 的优势

## 11.1 省掉 critic，减少资源开销

PPO 中 value model 往往和 policy model 规模相近，训练和推理都会带来额外显存与计算开销。GRPO 用组内平均 reward 作为 baseline，避免额外训练 critic。

## 11.2 适合可验证任务

GRPO 特别适合 reward 比较可靠的场景，例如：

```text
数学题：答案是否正确
代码题：单元测试是否通过
格式任务：JSON/XML 是否合法
工具调用：参数是否符合 schema
检索任务：答案是否被证据支持
```

这些任务中的 reward 可以由规则、测试器或 verifier 提供，不一定需要复杂的人类偏好模型。

## 11.3 天然适合相对偏好优化

GRPO 的组内比较机制很适合表达：

```text
同一个问题下，哪个回答更好？
```

这和很多 reward model / preference model 的训练数据形式一致，因为偏好数据通常也是在同一个 prompt 下比较多个回答。

## 11.4 实现结构相对简单

GRPO 的核心训练循环相对清晰：

```text
采样多个回答
    ↓
打分
    ↓
组内标准化 advantage
    ↓
PPO-style ratio + clip 更新
    ↓
KL 约束防止跑偏
```

# 12. GRPO 的局限与风险

## 12.1 轨迹级 reward 导致信用分配粗糙

在 outcome-level GRPO 中，一条回答通常只有一个最终 reward，这个 reward 对整条回答中的所有 token 共享。

因此模型无法直接知道：

```text
最后失败到底是哪一步导致的？
最后成功到底是哪一步贡献最大？
```

这会带来误伤。例如：

```text
前 99 步推理正确，最后一步算错；
最终 reward = 0；
整条轨迹都会被负向更新。
```

## 12.2 一组全坏时，会鼓励“相对没那么坏”的坏轨迹

GRPO 的 advantage 是组内相对值：

$$
A_i=\frac{r_i-\mu}{\sigma+\epsilon}
$$

假设同组回答全部有问题：

```text
回答1：reward = -10
回答2：reward = -9
回答3：reward = -8
回答4：reward = -7
```

组内均值：

$$
\mu=-8.5
$$

那么：

```text
-8 和 -7 会得到正 advantage，
因为它们比组内平均“不那么坏”。
```

这说明：

> 标准 GRPO 是相对偏好优化器，不是硬原则约束器。

如果要抑制原则性 bad case，例如隐私泄露、危险指导、伪造引用、严重幻觉，不能只依赖普通组内标准化 advantage。

## 12.3 Reward hacking

模型会优化 reward，而不是优化人类真正想要的目标。如果 reward 只奖励“简洁”，模型可能学会少说话；如果 reward 只奖励“分点”，模型可能所有回答都机械分点。

因此 reward 设计要避免只奖励表面特征。

## 12.4 长时间单阶段训练容易边际递减

GRPO 中存在 clip 和 KL 约束：

- clip 限制当前模型相对 old policy 的局部变化；
- KL 限制当前模型相对 reference policy 的偏离。

如果长时间在同一数据分布、同一 reward、同一 reference 下训练，可能出现：

```text
高 reward 行为已经被强化；
低 reward 行为已经被压低；
组内 reward 方差下降；
KL 代价越来越高；
reward 信号趋于饱和。
```

此时边际收益会下降。

但多阶段 GRPO 不只是把训练切成几段。真正有意义的多阶段训练通常会改变：

```text
数据难度
reward 结构
采样分布
reference model
KL 系数
训练目标
```

如果每一阶段刷新 reference model，例如：

$$
\pi_{ref}^{(1)}=\pi_0
$$

$$
\pi_{ref}^{(2)}=\pi_1
$$

$$
\pi_{ref}^{(3)}=\pi_2
$$

那么模型可以通过多个局部 trust region 逐步远离最初模型。这可能获得比单阶段 fixed-reference 训练更大的分布迁移能力。但它本质上也放宽了全局 KL 约束，更容易累积 reward hacking、模板化和能力退化风险。

一个折中做法是同时保留局部和全局 KL：

$$
L = L_{GRPO}
+
\beta_{local}D_{KL}(\pi_\theta||\pi_{ref-stage})
+
\beta_{global}D_{KL}(\pi_\theta||\pi_0)
$$

# 13. 如何用 GRPO 强化某种回复偏好？

想用 GRPO 强化模型偏好，核心前提不是“我希望模型这样回答”，而是：

> 这种偏好必须能被稳定打分，并且模型在采样时能产生好坏有差异的多个候选回答。

## 13.1 前提一：偏好必须能转成 reward

例如想强化“清晰、简洁、谨慎”，可以设计：

$$
R(q,o)
=
R_{quality}
+
0.2R_{structure}
+
0.2R_{brevity}
+
0.2R_{uncertainty}
-
P_{hallucination}
-
P_{unsafe}
$$

但更推荐加入硬门槛：

```text
如果答案明显错误：直接低分；
如果没有回答问题：直接低分；
如果违反安全边界：直接低分；
如果存在严重幻觉：直接低分；
只有质量合格后，才计算风格、简洁、结构等加分项。
```

原则是：

```text
正确性 / 安全性 / 有帮助 是门槛；
风格 / 格式 / 简洁 是加分项。
```

## 13.2 前提二：同组回答要有差异

如果同一 prompt 下采样出的回答分数都一样：

```text
0.8, 0.8, 0.8, 0.8
```

那么 \(\sigma \approx 0\)，几乎没有学习信号。

理想情况是：

```text
0.9, 0.6, 0.2, 0.1
```

这样 GRPO 才能判断哪些回答相对更优。

## 13.3 前提三：模型需要具备目标行为的“种子”

GRPO 更像是放大已有好行为，而不是从零发明一种模型完全不会的能力。

如果模型从来不会输出目标格式或目标风格，最好先做 SFT：

```text
SFT 教会模型“会这样回答”；
GRPO 强化模型“更愿意这样回答”。
```

## 13.4 前提四：reward 要抗作弊

不要奖励单一表面特征。例如：

```text
越短越好
```

会让模型倾向于过度简短甚至不回答。

更好的 reward 是分层的：

```text
先确保正确、有用、安全；
再奖励清晰、简洁、格式稳定。
```

# 14. 一次有效 GRPO 训练的推荐流程

## Step 1：定义训练目标

不要只写“让模型回答更好”，而是拆成可测量维度：

```text
准确性
相关性
结构清晰
语气合适
适度简洁
不编造
必要时澄清
遵守格式
安全边界
```

## Step 2：准备 prompt 集

GRPO 训练的核心数据是 prompt，而不是标准答案。prompt 应覆盖真实使用分布：

```text
普通问题
复杂问题
模糊问题
用户情绪化问题
需要拒绝的问题
需要澄清的问题
格式约束问题
边界和对抗样本
```

## Step 3：每个 prompt 采样 \(G\) 个回答

一般可以从：

```text
G = 4 或 8
```

开始。\(G\) 越大，组内比较越稳定，但生成成本也越高。

采样参数要有适度多样性：

```text
temperature 太低：回答太像，reward 方差小；
temperature 太高：回答太乱，reward 噪声大。
```

目标是让同一 prompt 下有好有坏。

## Step 4：计算 reward

reward 可以来自：

```text
规则函数：格式、长度、关键词、JSON 合法性；
验证器：数学答案、代码测试、编译器、检索校验；
reward model：学习人类偏好的打分器；
LLM judge：用强模型做多维评分；
人工评审：小规模高质量验证。
```

## Step 5：组内标准化 advantage

$$
A_i=\frac{r_i-\mu_q}{\sigma_q+\epsilon}
$$

可选地对 advantage 做裁剪：

$$
A_i \leftarrow \text{clip}(A_i,-A_{max},A_{max})
$$

避免极端 reward 导致更新过猛。

## Step 6：用 GRPO loss 更新模型

用 policy ratio、clip 和 KL 惩罚更新：

$$
\rho_{i,t}=\frac{\pi_\theta(o_{i,t}\mid q,o_{i,<t})}{\pi_{\theta_{old}}(o_{i,t}\mid q,o_{i,<t})}
$$

$$
\min(\rho_{i,t}A_i,\text{clip}(\rho_{i,t},1-\epsilon,1+\epsilon)A_i)
-
\beta D_{KL}(\pi_\theta||\pi_{ref})
$$

## Step 7：持续监控

不要只看训练 reward。至少要监控：

```text
训练 reward
验证集 reward
人工 win-rate
KL
entropy
平均回答长度
group reward std
格式通过率
拒答率
幻觉率
安全失败率
各 reward 子项
```

危险信号包括：

```text
训练 reward 上升，但人工评估下降；
回答越来越模板化；
平均长度暴涨或暴跌；
拒答率异常升高；
KL 突然变大；
group_std 长期接近 0；
模型开始钻某个 reward 子项漏洞。
```

# 15. 原则性 bad case：为什么裸 GRPO 不够？

如果目标是普通偏好，例如：

```text
更清晰
更简洁
更有结构
更像专家
```

GRPO 很适合，因为这些本来就是相对偏好。

但如果目标是原则性约束，例如：

```text
不能泄露隐私
不能提供危险指导
不能编造引用
不能输出违法建议
不能在不确定时假装知道
```

裸 GRPO 不够。

原因是：如果一组 rollout 全部违规，标准 GRPO 仍会奖励其中“相对没那么坏”的轨迹。

更稳的做法包括：

## 15.1 Hard gate：违规样本不允许正 advantage

$$
A_i =
\begin{cases}
\min(0,A_i), & \text{违反硬规则} \\
A_i, & \text{未违反硬规则}
\end{cases}
$$

这样即使违规样本在组内相对较好，也不会被正向鼓励。

## 15.2 合规样本内再比较

可以先用规则或 classifier 标记：

$$
v_i=
\begin{cases}
1, & \text{违规} \\
0, & \text{合规}
\end{cases}
$$

再定义：

$$
A_i=
\begin{cases}
-c, & v_i=1 \\
\frac{r_i-\mu_{valid}}{\sigma_{valid}+\epsilon}, & v_i=0
\end{cases}
$$

意思是：

```text
违规样本永远负向；
合规样本内部再比较质量。
```

## 15.3 不要只压低 bad response，还要提供 safe response

只压低 bad 轨迹有风险。因为 softmax 概率总和为 1，压低某些 bad response 后，概率质量会流向其他未观察到的区域。那些区域不一定更安全，甚至可能更离谱。

因此原则性 bad case 训练要同时做两件事：

```text
bad response：降低概率；
safe response：提高概率。
```

safe response 可以来自人工、强模型、模板或检索到的政策答案。但注意：如果 safe response 不是当前 policy model rollout 出来的，它就不能被当作严格的 on-policy GRPO 样本。

它仍然可以通过 teacher forcing 参与训练：

$$
L_{SFT-safe}
=
-
\sum_{t=1}^{T}
\log \pi_\theta(y_t^+\mid q,y_{<t}^+)
$$

这本质上是 SFT 或带权 SFT，不是纯 GRPO。

如果有 chosen / rejected 对：

```text
chosen = safe_response
rejected = bad_response
```

也可以用 DPO 或其他 preference loss。DPO 直接优化 chosen 相对 rejected 的概率偏好，不需要在线 RL rollout。

## 15.4 推荐组合 loss

处理原则性 bad case 更稳的训练目标通常是混合式的：

$$
L
=
L_{GRPO-valid}
+
\lambda L_{unlikelihood-bad-span}
+
\gamma L_{SFT-safe}
+
\beta_{local}D_{KL}(\pi_\theta||\pi_{ref-stage})
+
\beta_{global}D_{KL}(\pi_\theta||\pi_0)
$$

各项作用：

```text
L_GRPO-valid：在合规回答中优化相对偏好；
L_unlikelihood-bad-span：压低明确违规片段；
L_SFT-safe：提供正确替代路径；
local KL：每阶段别跳太猛；
global KL：总体别忘本、别漂移太远。
```

# 16. 多阶段 GRPO：为什么可能比单阶段长训更好？

单阶段 fixed-reference GRPO 通常优化：

$$
\max_\theta \mathbb E[R] - \beta D_{KL}(\pi_\theta||\pi_0)
$$

其中 \(\pi_0\) 是最初 reference model。

如果一直固定 \(\pi_0\)，模型越远离初始模型，KL 代价越大。

多阶段训练可以设为：

$$
\pi_{ref}^{(1)}=\pi_0
$$

$$
\pi_{ref}^{(2)}=\pi_1
$$

$$
\pi_{ref}^{(3)}=\pi_2
$$

每阶段优化：

$$
\max_\theta \mathbb E[R_k] - \beta_kD_{KL}(\pi_\theta||\pi_{k-1})
$$

这样做相当于：

```text
每一阶段局部保守，
但多阶段累积后可以全局走得更远。
```

它可能提升效果，尤其当目标偏好需要较大分布迁移时。但风险是：

```text
reward hacking 逐阶段累积；
模型越来越模板化；
早期偏差被下一阶段当作新基准；
通用能力逐步退化；
安全边界可能被慢慢侵蚀。
```

因此多阶段 GRPO 最好配合：

```text
阶段性独立评测；
全局 KL anchor；
混合通用数据；
人工抽检；
bad case 回归集；
checkpoint selection。
```

# 17. GRPO、SFT、DPO、PPO 的关系

| 方法 | 适合解决的问题 | 核心信号 | 优点 | 局限 |
|---|---|---|---|---|
| SFT | 教模型会不会做 | 标准答案 token | 简单稳定 | 不直接优化偏好 |
| DPO | 已有 chosen/rejected 偏好对 | 偏好对 | 不需要在线 RL，训练简单 | 依赖离线偏好数据 |
| PPO | 通用 RLHF / 复杂 reward | critic-based advantage | 细粒度、样本效率可能更好 | critic 成本高且难训 |
| GRPO | 可自动打分、多候选相对优化 | group-relative advantage | 省 critic，适合推理/代码/格式 | credit assignment 粗，全坏组有风险 |

实践上常见组合是：

```text
SFT：教会目标行为
DPO：用偏好对做初步对齐
GRPO：在线采样，强化高 reward 轨迹
SFT/DPO safe anchor：处理原则性 bad case
KL：防止训练跑偏
```

# 18. 实战 Checklist

## 18.1 适合上 GRPO 的情况

```text
偏好可以稳定打分；
同一个 prompt 下能采样出好坏不同的回答；
模型已经具备目标行为雏形；
reward 不容易被表面模式欺骗；
有 held-out eval 和人工抽检；
可以承受多样本 rollout 成本。
```

## 18.2 不适合裸 GRPO 的情况

```text
偏好极其主观，reward 不稳定；
模型完全不会目标行为；
所有样本 reward 都差不多；
目标是硬安全约束但没有 hard gate；
只奖励表面格式或长度；
没有验证集，只看训练 reward。
```

## 18.3 训练前检查

```text
reward 是否真的代表目标偏好？
reward 是否有明显漏洞？
prompt 是否覆盖真实场景？
同组 reward std 是否健康？
是否有原则性 bad case 的专门处理？
是否准备了 safe response 或偏好对？
是否设置了 KL 和 checkpoint 回滚机制？
```

## 18.4 训练中监控

```text
训练 reward 和验证 reward 是否同步上升？
人工评估是否提升？
KL 是否稳定？
回答长度是否异常变化？
拒答率是否异常变化？
是否越来越模板化？
是否出现 reward hacking？
原则性 bad case 是否真的下降？
```

# 19. 总结

GRPO 的本质可以压缩成一句话：

> **对同一个 prompt 生成多条回答，用组内相对 reward 计算 advantage，再用 PPO 风格的 ratio clipping 和 KL 约束更新模型。**

它的价值在于：

```text
不用 critic；
训练结构简单；
省显存和计算；
适合可验证任务；
能强化高 reward 的生成模式。
```

它的代价在于：

```text
需要同 prompt 多采样；
credit assignment 粗糙；
全坏组可能鼓励“相对没那么坏”的坏轨迹；
reward 设计不当会导致 reward hacking；
长时间单阶段训练有边际递减和 drift 风险。
```

最重要的实践原则是：

```text
SFT 教会模型“会做”；
reward 定义“什么更好”；
GRPO 放大“高 reward 轨迹”；
KL 和评测防止“训歪”；
hard gate / SFT / DPO safe anchor 处理原则性 bad case。
```

如果把 PPO 看成“用 critic 提供预期分”，那么 GRPO 就是“不找估分老师，而是让同一道题多写几份，组内互相比”。它不是万能的安全约束器，但在 reward 可靠、采样有差异、评测闭环完善的前提下，是一种非常实用的 LLM 强化学习后训练方法。

# 参考资料

1. Shao, Zhihong, et al. **DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models**. arXiv:2402.03300. https://arxiv.org/abs/2402.03300
2. Guo, Daya, et al. **DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning**. arXiv:2501.12948. https://arxiv.org/abs/2501.12948
3. Hugging Face TRL Documentation. **GRPO Trainer**. https://huggingface.co/docs/trl/en/grpo_trainer
4. Schulman, John, et al. **Proximal Policy Optimization Algorithms**. arXiv:1707.06347. https://arxiv.org/abs/1707.06347
5. Rafailov, Rafael, et al. **Direct Preference Optimization: Your Language Model is Secretly a Reward Model**. arXiv:2305.18290. https://arxiv.org/abs/2305.18290
