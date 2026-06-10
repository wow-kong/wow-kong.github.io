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
- After rendering articles, run `node scripts/check-articles.js` from the repository root. This verifies frontmatter, generated output freshness, article media paths, shared asset versions, and local HTML/CSS references.
- Keep article metadata in Markdown frontmatter, including `title`, `date`, `created_at`, `last_modified_at`, `description`, `categories`, `tags`, `thumbnail`, `hero_image`, `hero_image_layout`, `body_class`, `read_time`, and `published`.
- Use relative Markdown media paths such as `![caption](assets/example.png)` for article-local images. Use `hero_image` for the article detail header background and `thumbnail` for article listing cards.
- Use explicit Markdown heading anchors such as `## Section title {#stable-section-id}` when a section needs a stable link or table-of-contents id. Keep article-specific heading ids in the Markdown source, not as special cases in `scripts/render-articles.js`.
- Treat `assets/articles.js` as generated data. It should only reflect existing article Markdown sources with `published` not set to `false`; do not preserve deleted or legacy article entries manually.
- If the generated HTML is wrong, fix `scripts/render-articles.js`, the Markdown source, or shared CSS; do not patch generated HTML by hand except for emergency debugging that is immediately folded back into the generator/source.
- Before finishing article work, verify generated pages for asset references, Markdown features used by the article, formula rendering, and article-list metadata.

## Shared Assets

- Shared CSS and JavaScript cache versions live in `scripts/site-config.js`. When changing `assets/site.css` or `assets/site.js`, update the relevant version in `scripts/site-config.js` and regenerate/check pages.
- Do not hand-edit generated article pages only to update asset versions; make the change through the generator/config and run `node scripts/render-articles.js`.

## Pre-Commit Review

- Before every commit, perform a systematic review of all current changes and the overall repository.
- Remove or optimize invalid, obsolete, redundant, or unreasonable files, styles, scripts, assets, and logic.
- Verify that page flows, asset references, privacy/access behavior, and shared UI logic still work as intended.
- Run `node scripts/check-articles.js` before committing changes that affect articles, shared assets, generated pages, or site navigation.
