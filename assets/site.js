(() => {
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
            const pathMatch = pastedUrl.pathname.match(/experience-([A-Za-z0-9_-]+)\.html$/);

            if (accessParam) {
                return accessParam;
            }

            if (directoryMatch) {
                return directoryMatch[1];
            }

            if (pathMatch) {
                return pathMatch[1];
            }
        } catch (error) {
            // Treat non-URL input as a plain sharing code.
        }

        return value
            .replace(/^\/?experience\//, "")
            .replace(/^experience-/, "")
            .replace(/\.html$/, "")
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
