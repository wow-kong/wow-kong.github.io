# Agents Guide

## Repo Context

This repository hosts Sun Zhifei's personal GitHub Pages website. It currently includes a public homepage, a technical-article listing and sample article flow, reusable article metadata and Markdown templates, and a share-code-gated personal experience section.

## Design Direction

- Keep the personal website layout and UI simple, elegant, and restrained.
- Prefer clear structure, calm spacing, readable typography, and consistent visual language over decorative complexity.
- Except for personal experience pages and individual article pages, keep the homepage and public subpage header/hero treatment consistent in navigation structure, layout, imagery, spacing, and visual tone. When one changes, review the others and keep them in sync.

## Technical Articles

- Treat each technical article's `article.md` as the source of truth. Do not manually copy or retype Markdown content into `index.html`.
- Put article source files under `articles/<article-slug>/`, with the Markdown at `articles/<article-slug>/article.md` and article-specific media under `articles/<article-slug>/assets/`.
- After creating or editing an article Markdown file, run `node scripts/render-articles.js` from the repository root. This generates `articles/<article-slug>/index.html` and synchronizes `assets/articles.js`.
- Keep article metadata in Markdown frontmatter, including `title`, `date`, `created_at`, `last_modified_at`, `description`, `categories`, `tags`, `thumbnail`, `hero_image`, `body_class`, `read_time`, and `published` when relevant.
- Use relative Markdown media paths such as `![caption](assets/example.png)` for article-local images. Use `hero_image` for the article detail header background and `thumbnail` for article listing cards.
- If the generated HTML is wrong, fix `scripts/render-articles.js`, the Markdown source, or shared CSS; do not patch generated HTML by hand except for emergency debugging that is immediately folded back into the generator/source.
- Before finishing article work, verify generated pages for asset references, Markdown features used by the article, formula rendering, and article-list metadata.

## Pre-Commit Review

- Before every commit, perform a systematic review of all current changes and the overall repository.
- Remove or optimize invalid, obsolete, redundant, or unreasonable files, styles, scripts, assets, and logic.
- Verify that page flows, asset references, privacy/access behavior, and shared UI logic still work as intended.
