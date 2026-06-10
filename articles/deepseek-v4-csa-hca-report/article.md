---
title: "DeepSeek-V4 中的 CSA/HCA 注意力机制解读"
date: 2026-05-20
created_at: 2026-05-20
last_modified_at: 2026-05-20
description: "系统梳理 DeepSeek-V4 中 CSA/HCA 的压缩、检索、滑动窗口与位置编码设计，以及它们在百万 token 上下文下的效率权衡。"
categories: ["LLM Systems"]
tags: ["LLM", "DeepSeek", "Attention", "KV Cache", "Long Context"]
thumbnail: /articles/deepseek-v4-csa-hca-report/assets/deepseek-v4-csa-hca-hero.jpg
hero_image: assets/deepseek-v4-csa-hca-hero.jpg
body_class: deepseek-attention-article
read_time: "18 min read"
published: true
---

> 面向对外分享/技术汇报的整理版。核心主题：DeepSeek-V4 如何用 **CSA（Compressed Sparse Attention）** 和 **HCA（Heavily Compressed Attention）** 在 1M token 上下文下压低 attention 计算量与 KV cache 成本。

这篇笔记重点放在机制拆解和工程权衡上：先区分“写 cache”和“读 cache”，再分别展开 CSA、HCA、sliding window、RoPE 与 MLA-like 结构之间的关系。文中涉及配置数值、公式和实现细节的地方，均沿用原始技术资料中的表述。

## 摘要

DeepSeek-V4 的 CSA/HCA 可以理解为：

> **不要让每个新 token 都翻完整历史原文；先把历史 KV cache 压成“摘要卡片”，再让当前 query token 去读这些卡片。**

其中：

- **CSA**：小块压缩，通常每 `m=4` 个 token 压成 1 个 compressed KV entry；然后用 indexer 选 top-k 压缩块做 attention。
- **HCA**：大块压缩，通常每 `m'=128` 个 token 压成 1 个 compressed KV entry；压缩得很狠，所以压缩后可以 dense attention 全部看。
- **Sliding window**：最近一小段 token 不压缩，保留原始 KV，用来弥补局部细节和因果性问题。

官方技术报告称，DeepSeek-V4 使用 CSA/HCA 混合注意力来提升长上下文效率；在 1M-token 场景下，V4-Pro 相比 V3.2 只需要约 27% single-token inference FLOPs 和 10% KV cache。[^report-eff]

## 1. 为什么要这么做：full attention 太贵

普通自回归 Transformer 在生成当前 token 时，需要用当前 query 去和历史所有 key/value 交互：

```text
当前 query token
    ↓
和过去所有 token 的 K/V 做 attention
```

如果上下文长度达到 1M token，问题会非常直接：

1. **KV cache 线性膨胀**：每个历史 token 都要保存 K/V。
2. **单 token 解码计算变重**：每生成一个 token，都要和大量历史 K/V 计算 attention score。
3. **长程任务越来越依赖超长上下文**：agent、跨文档分析、长链推理都会把上下文拉得很长。

DeepSeek-V4 的办法是：

```text
历史 token 原始 KV
    ↓
压缩成更少的 compressed KV entries
    ↓
当前 query 只和这些 compressed entries + 最近窗口原始 KV 交互
```



## 2. 先分清两件事：写 cache 和读 cache

理解 CSA/HCA 最重要的是把过程拆成两步。

### 2.1 写 cache：历史 KV 怎么被压缩

对某一层来说，历史 token 的 hidden states 是：

$$
H = [h_1, h_2, \dots, h_n]
$$

压缩阶段主要使用这些 **KV token 自己的 hidden state** 生成：

```text
KV 内容 C：这个 token 要贡献什么信息
compression score Z：这个 token 在块内有多重要
```

这一阶段一般不看当前 decoding query token。也就是说，某个历史块压成什么样，基本在写入 compressed cache 时就定了。

### 2.2 读 cache：当前 query 怎么读取压缩历史

当前 token 来了之后，会产生 query，然后：

- 在 **CSA** 中：先通过 Lightning Indexer 给 compressed blocks 打分，选 top-k；再对 top-k compressed KV 做 attention。
- 在 **HCA** 中：不做 top-k，直接对所有 heavily compressed KV 做 dense attention。
- 同时，当前 query 还会看最近 `n_win` 个未压缩的原始 KV entries。

因此可以概括为：

```text
压缩阶段：query-independent
读取阶段：query-dependent
```

这也是 CSA/HCA 的根本 trade-off：牺牲一部分 token-level per-query 精细选择能力，换取超长上下文下可缓存、可复用、可承受的推理成本。



## 3. CSA：小块压缩 + 稀疏选块

CSA 全称 **Compressed Sparse Attention**。它的流程是：

```text
历史 KV token
    ↓
每 m 个 token 压成 1 个 compressed KV entry
    ↓
当前 query 用 Lightning Indexer 选 top-k compressed entries
    ↓
当前 query 对这些 selected compressed entries 做 attention
    ↓
再加上最近 sliding window 的原始 KV
```

DeepSeek-V4 中 CSA 的压缩率设置为：

$$
m = 4
$$

即大致每 4 个 token 压成 1 个 compressed KV entry；V4-Flash 的 CSA attention top-k 是 512，V4-Pro 的 CSA attention top-k 是 1024。[^report-config]



## 4. compression weights 怎么生成

以 CSA 为例。模型从 hidden states `H` 生成两类东西：

$$
C = H W^{KV}
$$

$$
Z = H W^Z
$$

其中：

- `C` 是每个 token 的 KV 内容。
- `Z` 是每个 token 的 compression score。
- `W^{KV}` 和 `W^Z` 都是可学习参数。

随后在一个 block 内加入可学习的块内位置 bias `B`：

$$
S = \operatorname{Softmax}_{block}(Z + B)
$$

然后做加权池化：

$$
C_i^{Comp} = \sum_{j \in block_i} S_j \odot C_j
$$

直观上就是：

```text
token:    A      B      C      D
score:   0.2    2.1    0.5    1.0
softmax: 0.08   0.54   0.11   0.27

compressed entry = 0.08*A + 0.54*B + 0.11*C + 0.27*D
```

但要注意，DeepSeek-V4 里的 score/weight 是 channel-wise 的，也就是每个 token 在每个维度上都可以有不同权重，而不是“一个 token 一个标量权重”。参考实现里 `wkv` 生成 KV 内容，`wgate` 生成 score，再用 softmax 后加权求和；代码注释称其为 learned gated pooling。[^code-compressor]



## 5. CSA 为什么是两路压缩：`a/b` 两路 + overlap

CSA 不是简单地每 4 个 token 独立压成一个 entry。它有两路：

$$
C^a = H W^{KV}_a, \quad C^b = H W^{KV}_b
$$

$$
Z^a = H W^Z_a, \quad Z^b = H W^Z_b
$$

对第 `i` 个 compressed entry，CSA 会把：

```text
当前 block:   [mi, ..., m(i+1)-1]        用 a 路
前一个 block: [m(i-1), ..., mi-1]        用 b 路
```

拼起来，在总共 `2m` 个位置上做同一个 softmax，然后加权求和。官方公式中也说明 softmax 是在来自 `Z^a` 与 `Z^b` 的总计 `2m` 个元素上归一化。[^report-csa-formula]

用 `m=4` 举例：

```text
block0: [0,1,2,3]
block1: [4,5,6,7]
block2: [8,9,10,11]

CSA entry0 ≈ compress(block0)
CSA entry1 ≈ compress(block0 as previous + block1 as current)
CSA entry2 ≈ compress(block1 as previous + block2 as current)
```

这里的重点是：

- 每个 compressed entry 实际参考 `2m` 个 KV entries。
- 相邻 compressed entries 的来源有重叠。
- 但由于步长仍然是 `m`，所以整体序列长度仍然压到原来的 `1/m`，而不是 `1/(2m)`。[^report-overlap]

### 为什么需要两路？

可以理解为：同一个 token 在两个相邻压缩 entry 中扮演的角色不同。

```text
当它是“当前块主体信息”时，用 a 路表示。
当它是“给下一个块补边界上下文”时，用 b 路表示。
```

这不是两个 attention head，而是为 overlap compression 服务的 role-specific projection。



## 6. CSA 的 Lightning Indexer：压缩后再 query-dependent 选块

压缩之后，CSA 并不会让当前 query 看所有 compressed entries，而是先做稀疏选择。

流程如下：

```text
当前 query token h_t
    ↓
低秩投影得到 indexer query q^I_t
    ↓
与 compressed indexer keys 计算 index score
    ↓
取 top-k compressed entries
    ↓
真正 attention 只在这些 entries 上做
```

公式上，index score 类似：

$$
I_{t,s} = \sum_h w^I_{t,h} \cdot \operatorname{ReLU}(q^I_{t,h} \cdot K^{IComp}_s)
$$

其中：

- `t` 是当前 query token。
- `s` 是历史 compressed block。
- `h` 是 indexer head。
- ReLU 会把某个 head 的负相关贡献截断为 0。

然后：

$$
\mathcal{C}^{SprsComp}_t = \operatorname{TopK}(I_{t,:})
$$

### ReLU 会不会导致 top-k 不满 K 个？

一般不会。因为这里不是“只选 score > 0 的 block”，而是“对合法 compressed blocks 排序后取 top-k”。参考实现中也是 `relu_()` 后直接调用 `topk(min(index_topk, end_pos // ratio))`。[^code-indexer]

因此：

```text
所有分数都是 0，也仍然可以取 top-k。
```

真正导致有效数量小于 K 的情况主要是：

1. 历史 compressed block 本来就不足 K 个。
2. 因果 mask 后，对靠前 token 来说可看的 preceding compressed blocks 数量不足，甚至为 0。

这时仍然还有 sliding window 的原始 KV 可用。



## 7. HCA：压得更狠，但压缩后全看

HCA 全称 **Heavily Compressed Attention**。它和 CSA 的核心区别是：

```text
CSA：压缩得比较轻，然后 top-k 选块
HCA：压缩得非常狠，然后 dense attention 全部看
```

HCA 的压缩方式类似 CSA，但更简单：

$$
C = H W^{KV}
$$

$$
Z = H W^Z
$$

$$
S = \operatorname{Softmax}_{block}(Z + B)
$$

$$
C_i^{Comp} = \sum_{j=m'i}^{m'(i+1)-1} S_j \odot C_j
$$

DeepSeek-V4 中 HCA 使用：

$$
m' = 128
$$

即大致每 128 个 token 压成 1 个 compressed KV entry。官方报告明确说，HCA 使用更大的压缩率 `m' >> m`，且不做 overlapped compression；压缩后执行 shared-KV MQA/dense attention。[^report-hca]



## 8. 既然 overlap 很重要，为什么 HCA 不做 overlap？

官方报告只给出事实：**HCA 不做 overlapped compression**。为什么这么设计，可以从工程定位上理解：

### 8.1 HCA 的目标不是边界细节，而是全局低分辨率视野

HCA 每 128 个 token 压成 1 个 entry，本来就是粗粒度全局记忆。它不负责精确保留每个边界附近的细节；细节主要交给 CSA 和 sliding window。

### 8.2 HCA 压缩后 dense attention，天然能看相邻块

CSA 有 top-k 选择，可能漏选边界另一侧的块，所以 overlap 对 CSA 更重要。

HCA 压缩后对所有 compressed entries 做 dense attention，边界两侧的相邻 compressed entries 都在候选集合里。它仍然会丢失 128-to-1 压缩带来的细节，但不太存在“top-k 选漏相邻块”的问题。

### 8.3 给 HCA 加 2m' overlap 成本不划算

如果 HCA 也做 `2m'` overlap，那么每个 compressed entry 要从 256 个 token 里做 gated pooling，成本和复杂度都会上升。HCA 的核心价值是极致降低长程全局 memory 成本，因此没有采用 overlap 是合理的工程折中。

> 这部分是基于结构的推断；报告本身只明确说明 HCA 不做 overlap。



## 9. Sliding window：最近 token 保留原始 KV

CSA/HCA 都会额外加入一段 **sliding window uncompressed KV**。官方报告解释：为了严格保持因果性，每个 query 只能看 preceding compressed KV blocks；因此 query 无法访问自己所在压缩块内的其他 token，而最近 token 通常又更相关，所以额外引入最近 `n_win` 个未压缩 KV entries。[^report-window]

直观例子：

```text
m = 4
block0: token 0,1,2,3 → compressed0
block1: token 4,5,6,7 → compressed1
```

如果当前正在处理 token 6，那么它不能看 `compressed1`，因为 `compressed1` 包含 token 7，属于未来信息。

所以当前 token 的候选 KV 大概是：

```text
远处历史：preceding compressed KV blocks
近处历史：最近 n_win 个原始 KV entries
```

DeepSeek-V4 的配置中，sliding window size 是：

$$
n_{win} = 128
$$

这就是为什么我们可以把它理解成：

```text
远古上下文看摘要，最近上下文看原文。
```



## 10. 语义边界问题：如果“一百一十万元”被切坏怎么办？

这个问题无法被完全消除。CSA/HCA 是固定 token 数分块，不是基于语义边界分块，所以它确实可能把一个完整语义单元切开。

但它有几层缓解机制。

### 10.1 CSA overlap 缓解边界切分

如果金额被切成：

```text
block A: ... 一百一
block B: 十万元 ...
```

没有 overlap 时，两个块各自压缩，语义可能断开。

CSA 的 overlap 让某个 compressed entry 同时参考前一个 block 和当前 block：

```text
CSA entry B ≈ compress(block A + block B)
```

因此跨边界短语有机会完整出现在某个 compressed entry 的输入范围内。

### 10.2 query 可以同时看多个 compressed entries

CSA 的 top-k 不是只选一个块，而是选一组 compressed entries；HCA 则直接看全部 compressed entries。因此边界两侧的信息可能被同时读取。

### 10.3 最近 128 token 直接看原始 KV

如果关键信息出现在最近窗口内，它不会只依赖压缩表示，而是以原始 KV 形式参与 attention。

### 10.4 channel-wise compression 比简单平均更强

compression weight 是按维度生成的，不是一个 token 一个标量。这意味着一个 compressed vector 的不同维度可以偏向不同 token，从而在高维空间中保留更多混合信息。

### 10.5 但它不是无损压缩

必须诚实地说：

> CSA/HCA 不是 full attention 的等价变换，也不是无损压缩。远处精确信息如果只经过重压缩，确实可能丢失细节。

它的设计目标不是“零损失”，而是：

```text
用可接受的信息损失，换取 1M 级上下文下可承受的计算和缓存成本。
```



## 11. query-independent 压缩的表达力损失

在 full attention 中，每个 query 都可以对同一组历史 token 重新分配注意力：

$$
\alpha_{t,j} = \operatorname{softmax}(q_t^\top k_j)
$$

即：

```text
query1 可以重点看 token A
query2 可以重点看 token B
```

而 CSA/HCA 的压缩阶段是：

$$
\tilde C_i = \sum_{j \in block_i} S_{i,j} C_j
$$

其中 `S_{i,j}` 由历史 token 的 hidden state 和 block 内 bias 生成，不依赖未来某个 query。

之后当前 query 只能对 compressed entries 做 attention：

$$
o_t = \sum_i \beta_{t,i} \tilde C_i
$$

展开：

$$
o_t = \sum_i \sum_{j \in block_i} \beta_{t,i} S_{i,j} C_j
$$

可以看到：

- `\beta_{t,i}` 是 query-dependent 的 block-level attention。
- `S_{i,j}` 是 query-independent 的 block-internal compression weight。

因此，CSA/HCA 不能完全保留 full attention 中“每个 query 对 block 内每个 token 重新加权”的能力。

为什么还这么做？因为这样 compressed KV entry 可以缓存和复用。如果压缩权重也依赖当前 query，就几乎要对每个新 token 重新压缩历史，成本会重新接近 full attention。



## 12. 位置编码：块内 learned bias 与全局 RoPE 是两套东西

这里最容易混淆。

### 12.1 compression bias 是块内相对位置，不是全局位置表

CSA/HCA 的 `B` 是 block 内位置 bias：

```text
block 内第 0 个 token 的 bias
block 内第 1 个 token 的 bias
...
block 内第 m-1 个 token 的 bias
```

它会在每个 block 中重复使用。

因此它不需要知道当前 token 是全文第 100 个、10 万个还是 100 万个。它只负责告诉 compressor：

```text
这个 token 在当前压缩块里的相对 offset 是多少。
```

参考实现中 `ape` 的形状是 `compress_ratio × head_dim`，overlap 时有两份维度；这说明它是按压缩块内部长度学习的，而不是全局绝对位置表。[^code-ape]

### 12.2 全局位置由 RoPE 负责

DeepSeek-V4 对 CSA/HCA 中的 query、KV entry 和 core attention output 使用 partial RoPE：只在最后 64 维应用 RoPE。因为 compressed KV entry 同时作为 key 和 value，attention output 还会在最后 64 维应用 query 位置的反向 RoPE，使输出更偏相对位置信息。[^report-rope]

参考实现中的顺序大致是：

```text
先压缩 KV
    ↓
得到 compressed KV entry
    ↓
对 compressed KV entry 的 RoPE 维度加 RoPE
```

即 RoPE 不是在 compression score 上做，而是在最终用于 attention 的 q/KV entry 上做。

### 12.3 compressed KV 用哪个位置？

从参考实现看，compressed KV 的 RoPE 位置大致使用 block 起始位置：

```text
CSA ratio=4:
block [0,1,2,3]       → position 0
block [4,5,6,7]       → position 4
block [8,9,10,11]     → position 8

HCA ratio=128:
block [0,...,127]     → position 0
block [128,...,255]   → position 128
```

代码中 prefill 使用 `freqs_cis[:cutoff:ratio]`，decode 使用 `freqs_cis[start_pos + 1 - compress_ratio]`，对应的正是块起始位置。[^code-rope-pos]

### 12.4 长度外推怎么做？

块内 learned bias 本身不负责长度外推，因为它不是全局 position embedding table，而是可重复使用的局部模板。

全局距离和长上下文位置主要依赖：

```text
query/KV 上的 RoPE
+ 训练中逐步扩展到长序列
+ 参考实现中对压缩层 RoPE 的 scaling 支持
```

所以更准确的说法是：

> learned block bias 不阻碍长度外推；它只处理 block 内相对位置。真正的全局位置关系由 RoPE 处理。



## 13. 低秩 Q 投影、RoPE 和 MLA-like 结构

HCA/CSA 的 query 生成采用低秩投影：

$$
c_t^Q = h_t W^{DQ}
$$

$$
q_t = c_t^Q W^{UQ}
$$

数学上，如果中间没有非线性或归一化，确实可以把两个矩阵合并：

$$
h_t W^{DQ} W^{UQ} = h_t W^Q
$$

但实际这么写有几个原因：

1. **低秩省参数/计算**：`d → d_c → n_h c` 比直接 `d → n_h c` 更省。
2. **中间有 RMSNorm**：参考实现是 `wq_a -> q_norm -> wq_b`，严格来说不能合并成单个线性层。
3. **中间 latent 可复用**：CSA 的 indexer query 和 core attention query 都可以从同一个 query latent 派生。

RoPE 加在哪里？

```text
h_t
  ↓ W_DQ
c_t^Q             # 低秩 latent，不加 RoPE
  ↓ W_UQ
q_t per head      # 形成 head_dim 后
  ↓
对最后 64 维加 RoPE
```

参考实现中 Attention 类注释写的是 “MLA with sliding window + optional KV compression”，并且确实有 `wq_a -> q_norm -> wq_b` 以及 grouped low-rank output projection。[^code-mla]

但这不等于 DeepSeek-V4 仍然完全使用 DeepSeek-V3 那种以 **KV latent cache** 为核心的 MLA。更准确的表述是：

```text
DeepSeek-V4 = MLA-like attention backbone
            + shared-KV/MQA 风格
            + sliding window 原始 KV
            + CSA/HCA 的序列维 KV 压缩
```

也就是说：

- V4 里有 MLA-like 的低秩 Q/O 投影结构。
- V4 的长上下文 KV cache 节省主要靠 CSA/HCA 沿序列维压缩 KV entries。
- 它不是简单的 “V3 MLA + CSA/HCA 叠加”。



## 14. CSA 和 HCA 的对照表

| 维度 | CSA | HCA |
|---|---|---|
| 全称 | Compressed Sparse Attention | Heavily Compressed Attention |
| 压缩率 | `m=4` | `m'=128` |
| 压缩粒度 | 小块，细一些 | 大块，粗很多 |
| 是否 overlap | 是 | 否 |
| 压缩后是否 top-k | 是，用 Lightning Indexer | 否，dense attention 全部看 |
| query 何时参与 | 压缩后：选块 + attention | 压缩后：attention |
| 适合承担 | 较细粒度远程检索 | 粗粒度全局视野 |
| 是否有 sliding window | 有，最近 `n_win=128` 原始 KV | 有，最近 `n_win=128` 原始 KV |
| 主要风险 | top-k 可能漏掉相关块；压缩非无损 | 128-to-1 压缩可能丢细节 |



## 15. DeepSeek-V4 关键配置

| 项目 | DeepSeek-V4-Flash | DeepSeek-V4-Pro |
|---|---:|---:|
| Transformer 层数 | 43 | 61 |
| 总参数 / 激活参数 | 284B / 13B | 1.6T / 49B |
| 前几层设置 | 前 2 层 pure sliding window | 前 2 层 HCA |
| 后续层 | CSA/HCA interleaved | CSA/HCA interleaved |
| CSA 压缩率 | `m=4` | `m=4` |
| CSA top-k | 512 | 1024 |
| HCA 压缩率 | `m'=128` | `m'=128` |
| sliding window | `n_win=128` | `n_win=128` |
| query compression dim | 1024 | 1536 |

配置来自官方技术报告的 model setups 部分。[^report-config]



## 16. 伪代码版：怎么实现

### 16.1 CSA 写 cache

```python
# H: historical hidden states

# 1. 生成两路 KV 内容和 compression score
C_a = H @ W_KV_a
C_b = H @ W_KV_b
Z_a = H @ W_Z_a
Z_b = H @ W_Z_b

# 2. 对每个 block 做 overlap compression
for i in range(num_blocks):
    current = block(i)      # [mi, ..., m(i+1)-1]
    previous = block(i - 1) # [m(i-1), ..., mi-1]

    score = concat(Z_a[current] + B_a,
                   Z_b[previous] + B_b)

    weight = softmax(score, dim="within_2m_window")

    compressed[i] = weighted_sum(
        concat(C_a[current], C_b[previous]),
        weight
    )
```

### 16.2 CSA 读 cache

```python
# current token hidden state: h_t

# 1. 生成 query latent
c_q = h_t @ W_DQ

# 2. indexer 选 compressed blocks
q_index = c_q @ W_IUQ
scores = relu(q_index @ compressed_index_keys.T)
selected = topk(scores, k)

# 3. 生成真正 attention query
q = c_q @ W_UQ

# 4. 拼接最近原始 KV 和 selected compressed KV
kv_candidates = concat(recent_raw_kv, compressed[selected])

# 5. 做 attention
out = attention(q, key=kv_candidates, value=kv_candidates)
```

### 16.3 HCA

```python
# 1. 每 128 个 token 压成 1 个 entry，不 overlap
C = H @ W_KV
Z = H @ W_Z

for i in range(num_hca_blocks):
    block = tokens[128*i : 128*(i+1)]
    weight = softmax(Z[block] + B)
    compressed[i] = weighted_sum(C[block], weight)

# 2. 当前 query dense attention 所有 compressed entries
q = low_rank_query_projection(h_t)
kv_candidates = concat(recent_raw_kv, compressed)
out = attention(q, key=kv_candidates, value=kv_candidates)
```



## 17. 对外分享时最推荐讲的比喻

可以把 1M token 上下文想成一本超长书。

普通 attention：

```text
每回答一个问题，都把整本书逐字翻一遍。
```

CSA：

```text
每 4 个 token 做一张小摘要卡；
当前问题先搜索相关卡片；
只精读 top-k 张卡片。
```

HCA：

```text
每 128 个 token 做一张大摘要卡；
卡片数量已经很少，所以全部扫一遍。
```

Sliding window：

```text
刚刚说过的话不看摘要，直接看原文。
```



## 18. 最终 takeaways

1. **CSA/HCA 的本质是 sequence-level KV cache compression**：不是减少 head，也不是普通剪枝，而是把历史 KV entries 沿序列维压短。
2. **compression weights 是 query-independent 的**：由历史 token 的 hidden states 和块内 learned bias 生成，不会为每个未来 query 重新分配块内 token 权重。
3. **当前 query 不是不参与，而是后参与**：CSA 中 query 参与 top-k 选块和 core attention；HCA 中 query 参与 dense attention。
4. **CSA 有 overlap，HCA 没有 overlap**：CSA 负责较细远程检索，HCA 负责粗粒度全局视野。
5. **sliding window 是关键补丁**：最近 128 token 保留原始 KV，既保持局部细节，也避免 query 因因果性无法访问自己所在压缩块的问题。
6. **块内 learned bias 不影响长度外推的主要逻辑**：它是局部 offset 模板；全局位置关系由 RoPE 负责。
7. **V4 有 MLA-like 成分，但主角是 CSA/HCA**：低秩 Q/O 投影类似 MLA skeleton，但长上下文 KV cache 节省主要来自序列维压缩。
8. **这不是无损压缩**：边界切分、远处精确信息和 query-dependent token-level selection 都存在表达力损失；DeepSeek-V4 用 overlap、channel-wise pooling、sliding window、top-k/dense hybrid 和多层交错来做工程折中。



## 参考资料 {#references}

[^report-eff]: DeepSeek-AI, *DeepSeek-V4: Towards Highly Efficient Million-Token Context Intelligence*, Technical Report. 相关内容包括：1M context、CSA/HCA hybrid attention、V4-Pro 相比 V3.2 的 FLOPs 与 KV cache 对比。

[^report-csa-formula]: DeepSeek-AI, *DeepSeek-V4 Technical Report*, Section 2.3.1, formulas (9)–(12): CSA 的两路 KV/score、compression weights、learnable positional biases 与 2m softmax。

[^report-overlap]: DeepSeek-AI, *DeepSeek-V4 Technical Report*, Section 2.3.1: 每个 CSA compressed entry 来自 2m 个 KV entries，但相邻 entry 有 overlap，因此序列长度实际压到 1/m。

[^report-hca]: DeepSeek-AI, *DeepSeek-V4 Technical Report*, Section 2.3.2, formulas (20)–(26): HCA 的大压缩率、不做 overlapped compression、dense shared-KV MQA。

[^report-window]: DeepSeek-AI, *DeepSeek-V4 Technical Report*, Section 2.3.3: sliding window branch 用于因果性与局部依赖建模。

[^report-rope]: DeepSeek-AI, *DeepSeek-V4 Technical Report*, Section 2.3.3: CSA/HCA 对 query、KV entry、attention output 的最后 64 维使用 partial RoPE，并对 output 使用反向 RoPE。

[^report-config]: DeepSeek-AI, *DeepSeek-V4 Technical Report*, Section 4.2.1: V4-Flash/V4-Pro 的层数、CSA/HCA interleaving、m=4、m'=128、top-k、n_win 等配置。

[^code-compressor]: DeepSeek-AI, DeepSeek-V4-Pro reference implementation, `inference/model.py`, `Compressor`: `wkv` 生成 KV 内容，`wgate` 生成 compression score，softmax 后加权求和。

[^code-indexer]: DeepSeek-AI, DeepSeek-V4-Pro reference implementation, `inference/model.py`, `Indexer`: index score 经 ReLU 后直接 top-k，且 top-k 数量受合法 compressed block 数限制。

[^code-ape]: DeepSeek-AI, DeepSeek-V4-Pro reference implementation, `inference/model.py`, `Compressor`: `ape` 参数按 `compress_ratio` 定义，说明 bias 是块内 offset 模板。

[^code-rope-pos]: DeepSeek-AI, DeepSeek-V4-Pro reference implementation, `inference/model.py`, `Compressor.forward`: compressed KV 加 RoPE 时 prefill 使用 `freqs_cis[:cutoff:ratio]`，decode 使用 `freqs_cis[start_pos + 1 - compress_ratio]`。

[^code-mla]: DeepSeek-AI, DeepSeek-V4-Pro reference implementation, `inference/model.py`, `Attention`: 注释为 “MLA with sliding window + optional KV compression”，实现包含 `wq_a -> q_norm -> wq_b` 和 grouped low-rank output projection。
