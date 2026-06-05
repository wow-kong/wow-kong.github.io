(() => {
    const siteNavItems = [
        { key: "home", label: "主页", href: "" },
        { key: "articles", label: "全部文章", href: "articles/" },
        { key: "experience", label: "经历", href: "experience/" },
        { key: "contact", label: "联系", href: "#profile" },
    ];

    const getSiteRoot = () => document.body.dataset.siteRoot || "";

    const resolveSitePath = (path) => {
        if (!path || /^(https?:|mailto:|#|\/)/.test(path)) {
            return path || "";
        }

        return `${getSiteRoot()}${path}`;
    };

    const resolveNavPath = (path) => {
        if (!path) {
            return getSiteRoot() || "./";
        }

        if (/^(https?:|mailto:|\/)/.test(path)) {
            return path;
        }

        if (path.startsWith("#")) {
            return `${getSiteRoot() || "./"}${path}`;
        }

        return `${getSiteRoot()}${path}`;
    };

    const renderSiteHeader = () => {
        document.querySelectorAll("[data-site-header]").forEach((header) => {
            const activeSection = header.dataset.activeSection || document.body.dataset.activeSection || "";
            const nav = document.createElement("nav");
            const links = document.createElement("div");

            nav.className = "nav nav-end";
            nav.setAttribute("aria-label", "主导航");
            links.className = "nav-links";

            siteNavItems.forEach((item) => {
                const link = document.createElement("a");
                link.href = resolveNavPath(item.href);
                link.textContent = item.label;

                if (item.key === activeSection) {
                    link.className = "active";
                    link.setAttribute("aria-current", "page");
                }

                links.appendChild(link);
            });

            nav.appendChild(links);
            header.textContent = "";
            header.appendChild(nav);
        });
    };

    renderSiteHeader();

    const copyButtons = document.querySelectorAll("[data-copy-email]");
    const copyStatus = document.querySelector("#contact-copy-status");

    const showCopyStatus = (text, isError = false) => {
        if (!copyStatus) {
            return;
        }

        copyStatus.textContent = text;
        copyStatus.classList.toggle("is-error", isError);
        copyStatus.hidden = false;

        window.clearTimeout(showCopyStatus.timeoutId);
        showCopyStatus.timeoutId = window.setTimeout(() => {
            copyStatus.hidden = true;
            copyStatus.textContent = "";
            copyStatus.classList.remove("is-error");
        }, 2200);
    };

    const copyText = async (text) => {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();

        try {
            if (!document.execCommand("copy")) {
                throw new Error("Copy command failed");
            }
        } finally {
            textarea.remove();
        }
    };

    copyButtons.forEach((button) => {
        button.addEventListener("click", async () => {
            const email = button.dataset.copyEmail;

            if (!email) {
                showCopyStatus("复制失败", true);
                return;
            }

            try {
                await copyText(email);
                showCopyStatus("邮箱已复制");
            } catch (error) {
                showCopyStatus("复制失败，请稍后重试", true);
            }
        });
    });

    const getArticleDateTime = (article) => {
        const timestamp = Date.parse(article.date || "");
        return Number.isNaN(timestamp) ? 0 : timestamp;
    };

    const articleItems = (Array.isArray(window.SZF_ARTICLES) ? window.SZF_ARTICLES : [])
        .slice()
        .sort((current, next) => getArticleDateTime(next) - getArticleDateTime(current));

    const createArticleCard = (article) => {
        const card = document.createElement("a");
        card.className = "article-card";
        card.href = resolveSitePath(article.href);
        card.setAttribute("aria-label", `阅读文章：${article.title}`);

        const media = document.createElement("span");
        media.className = "article-card-media";
        media.setAttribute("role", "img");
        media.setAttribute("aria-label", article.title);
        media.style.backgroundImage = `url("${resolveSitePath(article.image)}")`;
        card.appendChild(media);

        const body = document.createElement("span");
        body.className = "article-card-body";

        const meta = document.createElement("span");
        meta.className = "article-card-meta";
        [article.date, article.category, article.readTime].filter(Boolean).forEach((item) => {
            const metaItem = document.createElement("span");
            metaItem.textContent = item;
            meta.appendChild(metaItem);
        });
        body.appendChild(meta);

        const title = document.createElement("span");
        title.className = "article-card-title";
        title.textContent = article.title;
        body.appendChild(title);

        if (article.description) {
            const description = document.createElement("span");
            description.className = "article-card-description";
            description.textContent = article.description;
            body.appendChild(description);
        }

        if (article.tags?.length) {
            const tags = document.createElement("span");
            tags.className = "article-card-tags";
            article.tags.forEach((tag) => {
                const tagItem = document.createElement("span");
                tagItem.textContent = tag;
                tags.appendChild(tagItem);
            });
            body.appendChild(tags);
        }

        card.appendChild(body);
        return card;
    };

    const renderArticleCards = (container, articles) => {
        container.textContent = "";

        if (!articles.length) {
            const empty = document.createElement("p");
            empty.className = "article-empty";
            empty.textContent = "文章正在整理中。";
            container.appendChild(empty);
            return;
        }

        articles.forEach((article) => {
            container.appendChild(createArticleCard(article));
        });
    };

    document.querySelectorAll("[data-recent-articles]").forEach((container) => {
        const limit = Number.parseInt(container.dataset.limit || "3", 10);
        renderArticleCards(container, articleItems.slice(0, limit));
    });

    const articleList = document.querySelector("[data-article-list]");

    if (articleList) {
        const pageSize = Number.parseInt(articleList.dataset.pageSize || "6", 10);
        const totalPages = Math.max(1, Math.ceil(articleItems.length / pageSize));
        const params = new URLSearchParams(window.location.search);
        const requestedPage = Number.parseInt(params.get("page") || "1", 10);
        const currentPage = Math.min(Math.max(requestedPage || 1, 1), totalPages);
        const start = (currentPage - 1) * pageSize;
        const pageArticles = articleItems.slice(start, start + pageSize);

        renderArticleCards(articleList, pageArticles);

        const pagination = document.querySelector("[data-article-pagination]");

        if (pagination) {
            pagination.textContent = "";

            const createPageLink = (label, page, isDisabled = false, isActive = false) => {
                const link = document.createElement(isDisabled ? "span" : "a");
                link.className = "pagination-link";
                link.textContent = label;

                if (isActive) {
                    link.classList.add("is-active");
                    link.setAttribute("aria-current", "page");
                }

                if (isDisabled) {
                    link.classList.add("is-disabled");
                } else {
                    link.href = page === 1 ? "./" : `./?page=${page}`;
                }

                return link;
            };

            pagination.appendChild(createPageLink("上一页", currentPage - 1, currentPage === 1));

            for (let page = 1; page <= totalPages; page += 1) {
                pagination.appendChild(createPageLink(String(page), page, false, page === currentPage));
            }

            pagination.appendChild(createPageLink("下一页", currentPage + 1, currentPage === totalPages));
        }
    }

    const gate = document.querySelector("[data-access-gate]");

    if (!gate) {
        return;
    }

    const form = document.querySelector("#access-form");
    const input = document.querySelector("#access-code");
    const message = document.querySelector("#access-message");
    const targetBase = gate.dataset.targetBase || ".";

    const showMessage = (text, isError = false) => {
        if (!message) {
            return;
        }

        message.textContent = text;
        message.classList.toggle("is-error", isError);
        message.hidden = false;
    };

    const setLoading = (isLoading) => {
        const button = form?.querySelector("button");

        if (button) {
            button.disabled = isLoading;
            button.textContent = isLoading ? "打开中" : "打开";
        }
    };

    const extractCode = (rawValue) => {
        const value = rawValue.trim();

        if (!value) {
            return "";
        }

        try {
            const pastedUrl = new URL(value, window.location.href);
            const accessParam = pastedUrl.searchParams.get("access");
            const directoryMatch = pastedUrl.pathname.match(/\/experience\/([A-Za-z0-9_-]+)\/?$/);

            if (accessParam) {
                return accessParam;
            }

            if (directoryMatch) {
                return directoryMatch[1];
            }
        } catch (error) {
            // Treat non-URL input as a plain sharing code.
        }

        return value
            .replace(/^\/?experience\//, "")
            .replace(/\/$/, "");
    };

    const openSharedPage = async (rawCode) => {
        const code = extractCode(rawCode).replace(/[^A-Za-z0-9_-]/g, "");

        if (!code) {
            showMessage("请输入分享码。", true);
            return;
        }

        const base = targetBase.replace(/\/$/, "");
        const target = `${base}/${code}/`;
        setLoading(true);
        showMessage("正在验证分享码...");

        try {
            if (window.location.protocol === "file:") {
                window.location.href = target;
                return;
            }

            const response = await fetch(target, { method: "HEAD", cache: "no-store" });

            if (!response.ok) {
                throw new Error("Invalid sharing code");
            }

            window.location.href = target;
        } catch (error) {
            setLoading(false);
            showMessage("分享码不正确，请检查分享信息。", true);
        }
    };

    form?.addEventListener("submit", (event) => {
        event.preventDefault();
        openSharedPage(input?.value || "");
    });

    const params = new URLSearchParams(window.location.search);
    const hashCode = window.location.hash.startsWith("#access=")
        ? decodeURIComponent(window.location.hash.replace("#access=", ""))
        : "";
    const queryCode = params.get("access");

    if (queryCode || hashCode) {
        openSharedPage(queryCode || hashCode);
    }
})();
