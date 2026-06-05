# wow-kong.github.io

## 写文章流程

文章正文只需要维护 Markdown：

1. 在 `articles/<article-slug>/article.md` 写正文和 frontmatter。
2. 图片放在 `articles/<article-slug>/assets/`，Markdown 中用相对路径引用，例如 `![图注](assets/example.png)`。
3. 运行：

```bash
node scripts/render-articles.js
```

脚本会根据 Markdown 自动生成对应的 `index.html`，并同步更新 `assets/articles.js` 里的文章列表。不要手工抄一份 Markdown 到 HTML。

常用 frontmatter 字段：

- `title`：文章标题。
- `date` / `created_at` / `last_modified_at`：创建和更新时间。
- `description`：列表页和文章首屏摘要。
- `categories` / `tags`：分类与标签。
- `thumbnail`：文章列表缩略图。
- `hero_image`：文章详情页 header 背景图，通常写 `assets/xxx.jpg`。
- `body_class`：可选，用于给单篇文章加专属样式。
- `read_time`：阅读时长。
- `published`：是否进入文章列表。
