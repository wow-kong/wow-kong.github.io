#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { cssVersion, jsVersion } = require("./site-config");
const {
  ARTICLE_DATA_FILE,
  ROOT,
  buildArticleOutputs,
  discoverMarkdownArticles,
  parseFrontmatter,
} = require("./render-articles");

const failures = [];

const fail = (message) => {
  failures.push(message);
};

const readFile = (filePath) => fs.readFileSync(filePath, "utf8");
const toSiteRelative = (filePath) => path.relative(ROOT, filePath);
const isExternalPath = (value) => /^(https?:|mailto:|data:|#)/.test(value);

const resolveArticleAsset = (articleDir, value) => {
  const cleanValue = value.split(/[?#]/)[0];

  if (!cleanValue || isExternalPath(cleanValue)) {
    return "";
  }

  if (cleanValue.startsWith("/")) {
    return path.join(ROOT, cleanValue.slice(1));
  }

  if (cleanValue.startsWith("articles/")) {
    return path.join(ROOT, cleanValue);
  }

  return path.join(articleDir, cleanValue);
};

const walkFiles = (directory, predicate, files = []) => {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === ".git") {
      return;
    }

    const filePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      walkFiles(filePath, predicate, files);
      return;
    }

    if (predicate(filePath)) {
      files.push(filePath);
    }
  });

  return files;
};

const validateRequiredFrontmatter = () => {
  const requiredFields = [
    "title",
    "date",
    "created_at",
    "last_modified_at",
    "description",
    "categories",
    "tags",
    "thumbnail",
    "hero_image",
    "read_time",
    "published",
  ];

  discoverMarkdownArticles().forEach(({ markdownPath }) => {
    const source = readFile(markdownPath);
    const { data } = parseFrontmatter(source);
    const label = toSiteRelative(markdownPath);

    requiredFields.forEach((field) => {
      if (data[field] === undefined || data[field] === "") {
        fail(`${label}: missing frontmatter field "${field}"`);
      }
    });

    if (!Array.isArray(data.categories) || !data.categories.length) {
      fail(`${label}: "categories" must be a non-empty array`);
    }

    if (!Array.isArray(data.tags) || !data.tags.length) {
      fail(`${label}: "tags" must be a non-empty array`);
    }
  });
};

const validateArticleAssets = () => {
  discoverMarkdownArticles().forEach(({ markdownPath }) => {
    const articleDir = path.dirname(markdownPath);
    const source = readFile(markdownPath);
    const { data, content } = parseFrontmatter(source);
    const label = toSiteRelative(markdownPath);

    ["thumbnail", "hero_image"].forEach((field) => {
      const value = data[field];
      const resolved = value ? resolveArticleAsset(articleDir, value) : "";

      if (resolved && !fs.existsSync(resolved)) {
        fail(`${label}: ${field} references missing asset "${value}"`);
      }
    });

    const imagePattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match;

    while ((match = imagePattern.exec(content))) {
      const value = match[1];
      const resolved = resolveArticleAsset(articleDir, value);

      if (resolved && !fs.existsSync(resolved)) {
        fail(`${label}: markdown image references missing asset "${value}"`);
      }
    }
  });
};

const validateGeneratedOutputs = () => {
  const { articlePages, articleDataContent } = buildArticleOutputs();

  articlePages.forEach(({ outputPath, html }) => {
    const label = toSiteRelative(outputPath);

    if (!fs.existsSync(outputPath)) {
      fail(`${label}: generated HTML file is missing`);
      return;
    }

    if (readFile(outputPath) !== html) {
      fail(`${label}: generated HTML is out of date; run node scripts/render-articles.js`);
    }
  });

  if (!fs.existsSync(ARTICLE_DATA_FILE)) {
    fail(`${toSiteRelative(ARTICLE_DATA_FILE)}: article data file is missing`);
  } else if (readFile(ARTICLE_DATA_FILE) !== articleDataContent) {
    fail(`${toSiteRelative(ARTICLE_DATA_FILE)}: article data is out of date; run node scripts/render-articles.js`);
  }
};

const validateAssetVersions = () => {
  walkFiles(ROOT, (filePath) => filePath.endsWith(".html")).forEach((htmlPath) => {
    const html = readFile(htmlPath);
    const label = toSiteRelative(htmlPath);
    const cssVersions = [...html.matchAll(/site\.css\?v=([A-Za-z0-9._-]+)/g)].map((match) => match[1]);
    const jsVersions = [...html.matchAll(/site\.js\?v=([A-Za-z0-9._-]+)/g)].map((match) => match[1]);

    cssVersions.forEach((version) => {
      if (version !== cssVersion) {
        fail(`${label}: site.css version "${version}" should be "${cssVersion}"`);
      }
    });

    jsVersions.forEach((version) => {
      if (version !== jsVersion) {
        fail(`${label}: site.js version "${version}" should be "${jsVersion}"`);
      }
    });
  });
};

const validateLocalHtmlReferences = () => {
  walkFiles(ROOT, (filePath) => filePath.endsWith(".html")).forEach((htmlPath) => {
    const html = readFile(htmlPath);
    const label = toSiteRelative(htmlPath);
    const referencePattern = /(?:src|href)="([^"]+)"/g;
    let match;

    while ((match = referencePattern.exec(html))) {
      const rawReference = match[1];

      if (!rawReference || isExternalPath(rawReference)) {
        continue;
      }

      const cleanReference = rawReference.split(/[?#]/)[0];

      if (!cleanReference || cleanReference.startsWith("#")) {
        continue;
      }

      const resolved = cleanReference.startsWith("/")
        ? path.join(ROOT, cleanReference.slice(1))
        : path.resolve(path.dirname(htmlPath), cleanReference);

      if (!fs.existsSync(resolved)) {
        fail(`${label}: local reference is missing "${rawReference}"`);
      }
    }
  });
};

const validateCssReferences = () => {
  walkFiles(ROOT, (filePath) => filePath.endsWith(".css")).forEach((cssPath) => {
    const css = readFile(cssPath);
    const label = toSiteRelative(cssPath);
    const cssUrlPattern = /url\((["']?)([^"')]+)\1\)/g;
    let match;

    while ((match = cssUrlPattern.exec(css))) {
      const rawReference = match[2];

      if (!rawReference || isExternalPath(rawReference)) {
        continue;
      }

      const cleanReference = rawReference.split(/[?#]/)[0];
      const resolved = cleanReference.startsWith("/")
        ? path.join(ROOT, cleanReference.slice(1))
        : path.resolve(path.dirname(cssPath), cleanReference);

      if (!fs.existsSync(resolved)) {
        fail(`${label}: CSS url() reference is missing "${rawReference}"`);
      }
    }
  });
};

validateRequiredFrontmatter();
validateArticleAssets();
validateGeneratedOutputs();
validateAssetVersions();
validateLocalHtmlReferences();
validateCssReferences();

if (failures.length) {
  console.error(`Article check failed with ${failures.length} issue(s):`);
  failures.forEach((message) => console.error(`- ${message}`));
  process.exit(1);
}

console.log("Article check passed.");
