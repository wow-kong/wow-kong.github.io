#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { cssVersion, jsVersion } = require("./site-config");

const ROOT = path.resolve(__dirname, "..");
const ARTICLES_DIR = path.join(ROOT, "articles");
const ARTICLE_DATA_FILE = path.join(ROOT, "assets", "articles.js");

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const escapeAttr = escapeHtml;

const stripOuterQuotes = (value) => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

const parseScalar = (rawValue) => {
  const value = rawValue.trim();

  if (!value) {
    return "";
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }

    return inner.split(",").map((item) => stripOuterQuotes(item));
  }

  return stripOuterQuotes(value);
};

const parseFrontmatter = (source) => {
  if (!source.startsWith("---\n")) {
    return { data: {}, content: source };
  }

  const closeIndex = source.indexOf("\n---", 4);
  if (closeIndex === -1) {
    return { data: {}, content: source };
  }

  const frontmatter = source.slice(4, closeIndex).split(/\r?\n/);
  const data = {};

  frontmatter.forEach((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      return;
    }

    data[match[1]] = parseScalar(match[2]);
  });

  return {
    data,
    content: source.slice(closeIndex + 5).replace(/^\r?\n/, ""),
  };
};

const slugifyClass = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const normalizeListImage = (thumbnail, slug) => {
  if (!thumbnail) {
    return "assets/article-hero-forest.jpg";
  }

  if (/^(https?:|data:)/.test(thumbnail)) {
    return thumbnail;
  }

  if (thumbnail.startsWith("/")) {
    return thumbnail.slice(1);
  }

  if (thumbnail.startsWith("assets/")) {
    return `articles/${slug}/${thumbnail}`;
  }

  return thumbnail;
};

const normalizeArticleHeroImage = (frontmatter, slug) => {
  const value = frontmatter.hero_image || frontmatter.thumbnail;

  if (!value || /^(https?:|data:)/.test(value)) {
    return value || "";
  }

  const normalized = value.startsWith("/") ? value.slice(1) : value;
  const articlePrefix = `articles/${slug}/`;

  if (normalized.startsWith(articlePrefix)) {
    return normalized.slice(articlePrefix.length);
  }

  if (value.startsWith("/") && normalized.startsWith("assets/")) {
    return `../../${normalized}`;
  }

  if (normalized.startsWith("../../assets/")) {
    return normalized;
  }

  if (normalized.startsWith("assets/")) {
    return normalized;
  }

  return value.startsWith("/") ? `../..${value}` : value;
};

const normalizeArticleHeroCssImage = (frontmatter, slug) => {
  const value = frontmatter.hero_image || frontmatter.thumbnail;

  if (!value || /^(https?:|data:)/.test(value)) {
    return value || "";
  }

  const normalized = value.startsWith("/") ? value.slice(1) : value;
  const articlePrefix = `articles/${slug}/`;

  if (normalized.startsWith(articlePrefix)) {
    return `../${normalized}`;
  }

  if (value.startsWith("/") && normalized.startsWith("assets/")) {
    return normalized.slice("assets/".length);
  }

  if (normalized.startsWith("../../assets/")) {
    return normalized.slice("../../assets/".length);
  }

  if (normalized.startsWith("assets/")) {
    return `../articles/${slug}/${normalized}`;
  }

  return value.startsWith("/") ? `..${value}` : value;
};

const inlineTokens = [];
let activeFootnotes = null;

const protectInlineToken = (html) => {
  const key = `\u0000INLINE_${inlineTokens.length}\u0000`;
  inlineTokens.push(html);
  return key;
};

const normalizeFootnoteId = (id, index) => {
  const normalized = slugifyClass(id);
  return normalized || `note-${index}`;
};

const renderFootnoteRef = (id) => {
  if (!activeFootnotes) {
    return `[^${id}]`;
  }

  const note = activeFootnotes.byId.get(id);
  if (!note) {
    return `[^${id}]`;
  }

  if (!note.index) {
    note.index = activeFootnotes.nextIndex;
    activeFootnotes.nextIndex += 1;
    activeFootnotes.ordered.push(note);
  }

  const count = activeFootnotes.refCounts.get(id) || 0;
  activeFootnotes.refCounts.set(id, count + 1);

  const refId = count ? `fnref-${note.htmlId}-${count + 1}` : `fnref-${note.htmlId}`;
  if (!note.backref) {
    note.backref = refId;
  }

  return `<sup class="footnote-ref" id="${escapeAttr(refId)}"><a href="#fn-${escapeAttr(note.htmlId)}">${note.index}</a></sup>`;
};

const renderInline = (rawText = "") => {
  inlineTokens.length = 0;

  let text = String(rawText)
    .replace(/`([^`]+)`/g, (_, code) =>
      protectInlineToken(`<code>${escapeHtml(code)}</code>`)
    )
    .replace(/\$([^$\n]+)\$/g, (_, tex) =>
      protectInlineToken(`<span class="math">\\(${escapeHtml(tex.trim())}\\)</span>`)
    )
    .replace(/\[\^([^\]]+)]/g, (_, id) =>
      protectInlineToken(renderFootnoteRef(id))
    );

  text = escapeHtml(text);

  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const safeHref = href.replace(/&amp;/g, "&");
      return `<a href="${escapeAttr(safeHref)}">${label}</a>`;
    });

  inlineTokens.forEach((html, index) => {
    text = text.replace(`\u0000INLINE_${index}\u0000`, html);
  });

  return text;
};

const countIndent = (line) => {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
};

const isFence = (line) => line.trim().startsWith("```");
const isDisplayMathDelimiter = (line) => line.trim() === "$$";
const isHorizontalRule = (line) => /^-{3,}$|^\*{3,}$|^_{3,}$/.test(line.trim());
const isHeading = (line) => /^#{1,6}\s+/.test(line.trim());
const isBlockquote = (line) => line.trim().startsWith(">");
const isImage = (line) => /^!\[[^\]]*]\([^)]+\)$/.test(line.trim());
const isListItem = (line) => /^(\s*)(?:[-*+]|\d+[.)])\s+/.test(line);
const isTableStart = (lines, index) => {
  const current = lines[index]?.trim() || "";
  const next = lines[index + 1]?.trim() || "";
  return current.includes("|") && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next);
};

const splitTableRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const renderTable = (rows) => {
  const header = splitTableRow(rows[0]);
  const bodyRows = rows.slice(2).map(splitTableRow);

  const table = [
    "<table>",
    "  <thead>",
    "    <tr>",
    ...header.map((cell) => `      <th>${renderInline(cell)}</th>`),
    "    </tr>",
    "  </thead>",
    "  <tbody>",
    ...bodyRows.flatMap((row) => [
      "    <tr>",
      ...row.map((cell) => `      <td>${renderInline(cell)}</td>`),
      "    </tr>",
    ]),
    "  </tbody>",
    "</table>",
  ].join("\n");

  return `<div class="article-table-wrap">\n${table}\n</div>`;
};

const renderDisplayMath = (mathLines) =>
  `<div class="math math-display">\\[\n${escapeHtml(mathLines.join("\n"))}\n\\]</div>`;

const renderBlockquote = (quoteLines, context) => {
  const contentLines = quoteLines.map((line) => line.replace(/^\s*>\s?/, ""));
  const nonEmpty = contentLines.filter((line) => line.trim());
  const first = nonEmpty[0]?.trim() || "";

  if (!context.hasRenderedContent && first && !first.startsWith("💡")) {
    context.hasRenderedContent = true;
    return `<p class="article-lead">${renderInline(nonEmpty.join(" "))}</p>`;
  }

  if (first.startsWith("💡")) {
    context.hasRenderedContent = true;
    const paragraphParts = contentLines
      .join("\n")
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    const callout = `<div class="article-callout">\n<p>${renderInline(paragraphParts[0])}</p>\n</div>`;
    const rest = paragraphParts
      .slice(1)
      .map((paragraph) => `<p>${renderInline(paragraph)}</p>`)
      .join("\n");

    return rest ? `${callout}\n<blockquote>\n${rest}\n</blockquote>` : callout;
  }

  context.hasRenderedContent = true;
  const paragraphs = contentLines
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${renderInline(paragraph)}</p>`)
    .join("\n");

  return `<blockquote>\n${paragraphs}\n</blockquote>`;
};

const parseExplicitHeadingId = (rawText) => {
  const match = rawText.match(/\s+\{#([A-Za-z0-9][A-Za-z0-9_-]*)\}$/);

  if (!match) {
    return { text: rawText, explicitId: "" };
  }

  return {
    text: rawText.slice(0, match.index).trim(),
    explicitId: match[1],
  };
};

const reserveHeadingId = (id, context) => {
  const count = context.headingIdCounts.get(id) || 0;
  context.headingIdCounts.set(id, count + 1);
  return count ? `${id}-${count + 1}` : id;
};

const getHeadingId = (text, context, explicitId = "") => {
  if (explicitId) {
    return reserveHeadingId(explicitId, context);
  }

  const ascii = slugifyClass(text);
  if (ascii) {
    return reserveHeadingId(ascii, context);
  }

  context.sectionCount += 1;
  return reserveHeadingId(`section-${context.sectionCount}`, context);
};

const renderHeading = (line, context) => {
  const match = line.trim().match(/^(#{1,6})\s+(.+)$/);
  const markdownLevel = match[1].length;
  const parsed = parseExplicitHeadingId(match[2].trim());
  const text = parsed.text;
  const htmlLevel = Math.min(markdownLevel + 1, 6);
  const id = getHeadingId(text, context, parsed.explicitId);
  context.headings.push({ id, text, level: htmlLevel });
  context.hasRenderedContent = true;
  return `<h${htmlLevel} id="${escapeAttr(id)}">${renderInline(text)}</h${htmlLevel}>`;
};

const renderImage = (line) => {
  const match = line.trim().match(/^!\[([^\]]*)]\(([^)]+)\)$/);
  const alt = match[1].trim();
  const src = match[2].trim();
  const caption = alt ? `\n  <figcaption>${renderInline(alt)}</figcaption>` : "";
  return `<figure class="article-figure">\n  <img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">${caption}\n</figure>`;
};

const renderList = (lines, startIndex, context) => {
  const firstMatch = lines[startIndex].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  const baseIndent = firstMatch[1].length;
  const ordered = /\d/.test(firstMatch[2][0]);
  const tag = ordered ? "ol" : "ul";
  const items = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!match || match[1].length !== baseIndent || /\d/.test(match[2][0]) !== ordered) {
      break;
    }

    const itemLines = [match[3]];
    const contentIndent = match[1].length + match[2].length + 1;
    index += 1;

    while (index < lines.length) {
      const line = lines[index];
      const nextMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (nextMatch && nextMatch[1].length === baseIndent) {
        break;
      }

      if (line.trim() && countIndent(line) <= baseIndent) {
        break;
      }

      const continuationIndent = Math.min(line.length, contentIndent);
      itemLines.push(line.slice(continuationIndent));
      index += 1;
    }

    const itemHtml = renderBlocks(itemLines, {
      ...context,
      isNested: true,
    }).html;
    items.push(`  <li>${itemHtml}</li>`);
  }

  context.hasRenderedContent = true;
  return {
    html: `<${tag}>\n${items.join("\n")}\n</${tag}>`,
    nextIndex: index,
  };
};

const isParagraphBoundary = (lines, index) => {
  const line = lines[index];
  if (line === undefined || !line.trim()) {
    return true;
  }

  return (
    isFence(line) ||
    isDisplayMathDelimiter(line) ||
    isHorizontalRule(line) ||
    isHeading(line) ||
    isBlockquote(line) ||
    isImage(line) ||
    isListItem(line) ||
    isTableStart(lines, index)
  );
};

const renderBlocks = (lines, context) => {
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isHorizontalRule(line)) {
      context.hasRenderedContent = true;
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (isDisplayMathDelimiter(line)) {
      const mathLines = [];
      index += 1;
      while (index < lines.length && !isDisplayMathDelimiter(lines[index])) {
        mathLines.push(lines[index]);
        index += 1;
      }
      index += index < lines.length ? 1 : 0;
      context.hasRenderedContent = true;
      html.push(renderDisplayMath(mathLines));
      continue;
    }

    if (isFence(line)) {
      const language = line.trim().slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !isFence(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += index < lines.length ? 1 : 0;
      context.hasRenderedContent = true;
      const languageClass = language ? ` class="language-${escapeAttr(language)}"` : "";
      html.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (isHeading(line)) {
      html.push(renderHeading(line, context));
      index += 1;
      continue;
    }

    if (isBlockquote(line)) {
      const quoteLines = [];
      while (index < lines.length && isBlockquote(lines[index])) {
        quoteLines.push(lines[index]);
        index += 1;
      }
      html.push(renderBlockquote(quoteLines, context));
      continue;
    }

    if (isImage(line)) {
      context.hasRenderedContent = true;
      html.push(renderImage(line));
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const rows = [];
      while (index < lines.length && lines[index].trim().includes("|")) {
        rows.push(lines[index]);
        index += 1;
      }
      context.hasRenderedContent = true;
      html.push(renderTable(rows));
      continue;
    }

    if (isListItem(line)) {
      const renderedList = renderList(lines, index, context);
      html.push(renderedList.html);
      index = renderedList.nextIndex;
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && !isParagraphBoundary(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    context.hasRenderedContent = true;
    html.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`);
  }

  return {
    html: html.join("\n"),
    headings: context.headings,
  };
};

const extractFootnotes = (markdown) => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const contentLines = [];
  const footnotes = [];

  lines.forEach((line) => {
    const match = line.match(/^\[\^([^\]]+)]:\s*(.*)$/);
    if (!match) {
      contentLines.push(line);
      return;
    }

    const index = footnotes.length + 1;
    footnotes.push({
      id: match[1],
      htmlId: normalizeFootnoteId(match[1], index),
      definitionIndex: index,
      index: 0,
      text: match[2],
      backref: "",
    });
  });

  return {
    content: contentLines.join("\n"),
    footnotes,
  };
};

const renderFootnotes = (footnotes) => {
  if (!footnotes.length) {
    return "";
  }

  const items = footnotes
    .map((note) => {
      const backref = note.backref || `fnref-${note.htmlId}`;
      return `  <li id="fn-${escapeAttr(note.htmlId)}"><p>${renderInline(note.text)} <a class="footnote-backref" href="#${escapeAttr(backref)}" aria-label="返回正文">返回</a></p></li>`;
    })
    .join("\n");

  return `<ol class="article-footnotes">\n${items}\n</ol>`;
};

const renderMarkdown = (markdown) => {
  const { content, footnotes } = extractFootnotes(markdown);
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const context = {
    hasRenderedContent: false,
    headingIdCounts: new Map(),
    headings: [],
    sectionCount: 0,
  };

  const previousFootnotes = activeFootnotes;
  activeFootnotes = {
    byId: new Map(footnotes.map((note) => [note.id, note])),
    refCounts: new Map(),
    ordered: [],
    nextIndex: 1,
  };

  const rendered = renderBlocks(lines, context);
  const unreferencedFootnotes = footnotes
    .filter((note) => !note.index)
    .sort((current, next) => current.definitionIndex - next.definitionIndex)
    .map((note) => {
      note.index = activeFootnotes.nextIndex;
      activeFootnotes.nextIndex += 1;
      return note;
    });
  const footnotesHtml = renderFootnotes([...activeFootnotes.ordered, ...unreferencedFootnotes]);
  activeFootnotes = previousFootnotes;

  return {
    html: [rendered.html, footnotesHtml].filter(Boolean).join("\n"),
    headings: rendered.headings,
  };
};

const formatTags = (tags = []) =>
  tags.map((tag) => `                        <span>${escapeHtml(tag)}</span>`).join("\n");

const formatToc = (headings) =>
  headings
    .filter((heading) => heading.level <= 4)
    .map(
      (heading) =>
        `                            <a class="toc-level-${heading.level}" href="#${escapeAttr(heading.id)}">${escapeHtml(heading.text)}</a>`
    )
    .join("\n");

const renderArticlePage = ({ slug, frontmatter, contentHtml, headings }) => {
  const title = frontmatter.title || "Untitled";
  const description = frontmatter.description || "";
  const category = Array.isArray(frontmatter.categories)
    ? frontmatter.categories[0]
    : frontmatter.category || "";
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  const readTime = frontmatter.read_time || frontmatter.readTime || "";
  const date = frontmatter.date || frontmatter.created_at || "";
  const updated = frontmatter.last_modified_at || frontmatter.updated_at || "";
  const bodyClass = frontmatter.body_class || "";
  const heroImage = normalizeArticleHeroImage(frontmatter, slug);
  const heroCssImage = normalizeArticleHeroCssImage(frontmatter, slug);
  const showHeroMedia = frontmatter.hero_image_layout === "inline";
  const heroStyle = heroCssImage
    ? ` style="--article-hero-image: url(&quot;${escapeAttr(heroCssImage)}&quot;)"`
    : "";
  const heroMedia = showHeroMedia && heroImage
    ? `\n                <img class="article-hero-media" src="${escapeAttr(heroImage)}" alt="">`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="${escapeAttr(description)}">
    <title>${escapeHtml(title)} | Sun Zhifei</title>
    <link rel="stylesheet" href="../../assets/site.css?v=${cssVersion}">
    <link rel="icon" href="../../assets/favicon.svg" type="image/svg+xml">
    <script>
        window.MathJax = {
            tex: {
                inlineMath: [["\\\\(", "\\\\)"], ["$", "$"]],
                displayMath: [["\\\\[", "\\\\]"], ["$$", "$$"]]
            },
            options: {
                skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"]
            }
        };
    </script>
    <script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
</head>
<body${bodyClass ? ` class="${escapeAttr(bodyClass)}"` : ""} data-site-root="../../" data-active-section="articles">
    <header class="site-header" data-site-header></header>

    <main>
        <article>
            <section class="article-hero" aria-label="文章标题区"${heroStyle}>
${heroMedia}
                <div class="hero-inner">
                    <p class="eyebrow">Technical Notes · ${escapeHtml(category)}</p>
                    <h1>${escapeHtml(title)}</h1>
                    <p class="hero-copy">${escapeHtml(description)}</p>
                    <div class="article-meta" aria-label="文章元信息">
                        ${date ? `<span>${escapeHtml(date)}</span>` : ""}
                        ${category ? `<span>${escapeHtml(category)}</span>` : ""}
                        ${readTime ? `<span>${escapeHtml(readTime)}</span>` : ""}
                    </div>
                    <div class="tags" aria-label="文章标签">
${formatTags(tags)}
                    </div>
                </div>
            </section>

            <section class="article-shell">
                <div class="container article-layout">
                    <div class="article-content">
${contentHtml}
                    </div>

                    <aside class="article-aside" aria-label="文章侧边栏">
                        <h2>目录</h2>
                        <nav class="article-toc" aria-label="文章目录">
${formatToc(headings)}
                        </nav>

                        <div class="article-info">
                            <h2>文章信息</h2>
                            ${category ? `<span>分类：${escapeHtml(category)}</span>` : ""}
                            ${date ? `<span>创建：${escapeHtml(date)}</span>` : ""}
                            ${updated ? `<span>更新：${escapeHtml(updated)}</span>` : ""}
                        </div>
                    </aside>
                </div>
            </section>
        </article>
    </main>

    <footer class="site-footer">
        <div class="footer-inner">
            <span>© 2026. All rights reserved.</span>
            <span>Built for GitHub Pages.</span>
        </div>
    </footer>
    <script src="../../assets/site.js?v=${jsVersion}"></script>
</body>
</html>
`;
};

const getSortedArticleData = (generatedArticles) =>
  generatedArticles.slice().sort(
    (current, next) => Date.parse(next.date || "") - Date.parse(current.date || "")
  );

const getArticleDataContent = (generatedArticles) => {
  const json = JSON.stringify(getSortedArticleData(generatedArticles), null, 4);
  return `window.SZF_ARTICLES = ${json};\n`;
};

const writeArticleData = (generatedArticles) => {
  fs.writeFileSync(ARTICLE_DATA_FILE, getArticleDataContent(generatedArticles));
};

const discoverMarkdownArticles = () =>
  fs
    .readdirSync(ARTICLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      slug: entry.name,
      markdownPath: path.join(ARTICLES_DIR, entry.name, "article.md"),
      outputPath: path.join(ARTICLES_DIR, entry.name, "index.html"),
    }))
    .filter((article) => fs.existsSync(article.markdownPath));

const buildArticleOutputs = () => {
  const generatedArticles = [];
  const articlePages = [];

  discoverMarkdownArticles().forEach(({ slug, markdownPath, outputPath }) => {
    const source = fs.readFileSync(markdownPath, "utf8");
    const { data: frontmatter, content } = parseFrontmatter(source);
    const rendered = renderMarkdown(content);
    const html = renderArticlePage({
      slug,
      frontmatter,
      contentHtml: rendered.html,
      headings: rendered.headings,
    });

    articlePages.push({
      slug,
      markdownPath,
      outputPath,
      html,
      frontmatter,
      headings: rendered.headings,
    });

    if (frontmatter.published !== false) {
      const category = Array.isArray(frontmatter.categories)
        ? frontmatter.categories[0]
        : frontmatter.category || "";
      generatedArticles.push({
        title: frontmatter.title || slug,
        description: frontmatter.description || "",
        date: frontmatter.date || frontmatter.created_at || "",
        category,
        readTime: frontmatter.read_time || frontmatter.readTime || "",
        href: `articles/${slug}/`,
        image: normalizeListImage(frontmatter.thumbnail, slug),
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      });
    }
  });

  return {
    articlePages,
    generatedArticles,
    articleDataContent: getArticleDataContent(generatedArticles),
  };
};

const writeArticleOutputs = ({ articlePages, generatedArticles }) => {
  articlePages.forEach(({ outputPath, html }) => {
    fs.writeFileSync(outputPath, html);
  });

  writeArticleData(generatedArticles);
};

const renderArticles = ({ write = true, log = true } = {}) => {
  const outputs = buildArticleOutputs();

  if (write) {
    writeArticleOutputs(outputs);
  }

  if (log) {
    console.log(`Rendered ${outputs.generatedArticles.length} markdown article(s).`);
  }

  return outputs;
};

module.exports = {
  ROOT,
  ARTICLES_DIR,
  ARTICLE_DATA_FILE,
  buildArticleOutputs,
  discoverMarkdownArticles,
  getArticleDataContent,
  normalizeArticleHeroImage,
  normalizeListImage,
  parseFrontmatter,
  renderArticles,
  renderMarkdown,
};

if (require.main === module) {
  renderArticles();
}
