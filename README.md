# wow-kong.github.io

## 写文章流程

文章正文只需要维护 Markdown：

1. 在 `articles/<article-slug>/article.md` 写正文和 frontmatter。
2. 图片放在 `articles/<article-slug>/assets/`，Markdown 中用相对路径引用，例如 `![图注](assets/example.png)`。
3. 运行生成脚本：

```bash
node scripts/render-articles.js
```

脚本会根据 Markdown 自动生成对应的 `index.html`，并同步更新 `assets/articles.js` 里的文章列表。不要手工抄一份 Markdown 到 HTML。

4. 运行检查脚本：

```bash
node scripts/check-articles.js
```

检查脚本会验证 frontmatter、文章图片引用、生成产物同步、资源版本号一致性，以及 HTML 本地资源引用。

常用 frontmatter 字段：

- `title`：文章标题。
- `date` / `created_at` / `last_modified_at`：创建和更新时间。
- `description`：列表页和文章首屏摘要。
- `categories` / `tags`：分类与标签。
- `thumbnail`：文章列表缩略图，推荐使用文章目录内的相对路径，例如 `assets/cover.jpg`。
- `hero_image`：文章详情页 header 背景图，推荐使用文章目录内的相对路径，例如 `assets/cover.jpg`。
- `hero_image_layout`：可选，设为 `inline` 时会把 hero 图作为覆盖全屏的 `<img>` 输出，适合需要更稳定控制图片裁切的文章。
- `body_class`：可选，用于给单篇文章加专属样式。
- `read_time`：阅读时长。
- `published`：是否进入文章列表。

标题可以在 Markdown 中显式指定稳定锚点：

```md
## 章节标题 {#stable-section-id}
```

生成 HTML 时 `{#stable-section-id}` 不会显示在页面中，但会成为该标题的目录链接和页面锚点。
