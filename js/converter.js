// HTML-to-MediaWiki conversion built on Turndown. Turndown owns DOM traversal;
// this module only supplies output-format rules and input sanitisation.
const defaultSettings = {
  preserveLineBreaks: false,
  externalLinks: true,
  tableClass: "wikitable",
};

function convertHtmlToMediaWiki(html, settings = {}) {
  const options = { ...defaultSettings, ...settings };
  const Turndown = globalThis.TurndownService;

  if (!Turndown) {
    throw new Error("Turndown failed to load");
  }

  const service = new Turndown({
    blankReplacement: () => "",
    keepReplacement: (content) => content,
  });

  service.use(mediaWikiPlugin(options));

  return cleanMediaWikiOutput(service.turndown(html || ""));
}

// A Turndown plugin for MediaWiki output. The table rules are deliberately
// local because table syntax is the one area not covered reliably by generic
// Markdown-oriented rules.
function mediaWikiPlugin(settings) {
  return (service) => {
    service.remove(["script", "style", "meta", "link", "iframe", "object", "embed"]);

    service.addRule("mediawiki-headings", {
      filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
      replacement(content, node) {
        const marker = "=".repeat(Number(node.nodeName.slice(1)));
        return content.trim() ? `\n\n${marker} ${content.trim()} ${marker}\n\n` : "";
      },
    });

    service.addRule("mediawiki-bold", {
      filter: ["strong", "b"],
      replacement: (content) => (content.trim() ? `'''${content.trim()}'''` : ""),
    });

    service.addRule("mediawiki-italic", {
      filter: ["em", "i"],
      replacement: (content) => (content.trim() ? `''${content.trim()}''` : ""),
    });

    service.addRule("mediawiki-underline", {
      filter(node) {
        return (
          node.nodeName === "U" ||
          /text-decoration(?:-line)?\s*:[^;]*underline/i.test(
            node.getAttribute("style") || "",
          )
        );
      },
      replacement: (content) => (content.trim() ? `<u>${content.trim()}</u>` : ""),
    });

    service.addRule("mediawiki-strike", {
      filter(node) {
        return (
          ["S", "STRIKE", "DEL"].includes(node.nodeName) ||
          /text-decoration(?:-line)?\s*:[^;]*line-through/i.test(
            node.getAttribute("style") || "",
          )
        );
      },
      replacement: (content) => (content.trim() ? `<s>${content.trim()}</s>` : ""),
    });

    service.addRule("mediawiki-links", {
      filter: "a",
      replacement(content, node) {
        const label = content.trim();
        const href = (node.getAttribute("href") || "").trim();

        if (!href || /^(?:javascript|data|vbscript):/i.test(href)) {
          return label;
        }
        if (href.startsWith("#")) {
          return `[[${href}${label ? `|${label}` : ""}]]`;
        }
        if (!settings.externalLinks) {
          return label || href;
        }
        return label && label !== href ? `[${href} ${label}]` : `[${href}]`;
      },
    });

    service.addRule("mediawiki-list-item", {
      filter: "li",
      replacement(content, node) {
        let marker = "";
        let list = node.parentElement;

        while (list && ["UL", "OL"].includes(list.nodeName)) {
          marker = `${list.nodeName === "OL" ? "#" : "*"}${marker}`;
          list = list.parentElement?.closest("ul, ol");
        }

        const lines = content
          .replace(/^\s+|\s+$/g, "")
          .replace(/\n{2,}/g, "\n")
          .split("\n");
        const value = lines.shift()?.trim() || "";
        const nestedItems = lines.filter(Boolean).join("\n");
        return `\n${marker} ${value}${nestedItems ? `\n${nestedItems}` : ""}`;
      },
    });

    service.addRule("mediawiki-lists", {
      filter: ["ul", "ol"],
      replacement(content, node) {
        const nested = node.parentElement?.closest("li");
        return nested ? content : `\n${content.trim()}\n`;
      },
    });

    service.addRule("mediawiki-blockquote", {
      filter: "blockquote",
      replacement(content) {
        const quoted = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => `: ${line}`)
          .join("\n");
        return quoted ? `\n\n${quoted}\n\n` : "";
      },
    });

    service.addRule("mediawiki-code", {
      filter(node) {
        return node.nodeName === "CODE" && node.parentNode?.nodeName !== "PRE";
      },
      replacement: (_content, node) =>
        `<code>${escapeWikiHtml(node.textContent || "")}</code>`,
    });

    service.addRule("mediawiki-pre", {
      filter: "pre",
      replacement: (_content, node) =>
        `\n\n<pre>${escapeWikiHtml(node.textContent || "").trim()}</pre>\n\n`,
    });

    service.addRule("mediawiki-line-break", {
      filter: "br",
      replacement: (_content, node) =>
        node.closest("table")
          ? "<br />"
          : settings.preserveLineBreaks
            ? "<br />\n"
            : "\n",
    });

    service.addRule("mediawiki-horizontal-rule", {
      filter: "hr",
      replacement: () => "\n\n----\n\n",
    });

    service.addRule("mediawiki-image", {
      filter: "img",
      replacement: (_content, node) => {
        const alt = (node.getAttribute("alt") || node.getAttribute("title") || "")
          .replace(/--/g, "—")
          .trim();
        return alt ? `<!-- Image omitted: ${alt} -->` : "<!-- Image omitted -->";
      },
    });

    service.addRule("mediawiki-sup-sub", {
      filter: ["sup", "sub"],
      replacement: (content, node) =>
        content.trim()
          ? `<${node.nodeName.toLowerCase()}>${content.trim()}</${node.nodeName.toLowerCase()}>`
          : "",
    });

    service.addRule("mediawiki-table-cell", {
      filter: ["th", "td"],
      replacement(content, node) {
        const marker = node.nodeName === "TH" ? "!" : "|";
        const attributes = tableCellAttributes(node);
        const trimmedContent = content.trim();
        const isPlaceholderOnly = !trimmedContent
          .replace(/<br\s*\/?>/gi, "")
          .trim();
        const value = isPlaceholderOnly
          ? ""
          : trimmedContent
              .replace(/\n{2,}/g, "<br />")
              .replace(/\n/g, settings.preserveLineBreaks ? "<br />" : " ")
              .trim();
        return `${marker} ${attributes ? `${attributes} | ` : ""}${value}\n`;
      },
    });

    service.addRule("mediawiki-table-row", {
      filter: "tr",
      replacement: (content) => `|-\n${content}`,
    });

    service.addRule("mediawiki-table-section", {
      filter: ["thead", "tbody", "tfoot"],
      replacement: (content) => content,
    });

    service.addRule("mediawiki-table-caption", {
      filter: "caption",
      replacement: (content) => (content.trim() ? `|+ ${content.trim()}\n` : ""),
    });

    service.addRule("mediawiki-table", {
      filter: "table",
      replacement(content) {
        const classAttribute = settings.tableClass
          ? ` class="${settings.tableClass}"`
          : "";
        return `\n\n{|${classAttribute}\n${content.trim()}\n|}\n\n`;
      },
    });

    service.addRule("mediawiki-paragraph", {
      filter: "p",
      replacement: (content) => (content.trim() ? `\n\n${content.trim()}\n\n` : ""),
    });
  };
}

function tableCellAttributes(node) {
  return ["colspan", "rowspan"]
    .map((name) => {
      const value = Number.parseInt(node.getAttribute(name) || "", 10);
      return Number.isFinite(value) && value > 1 ? `${name}="${value}"` : "";
    })
    .filter(Boolean)
    .join(" ");
}

function cleanMediaWikiOutput(value) {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

// Sanitisation is separate from conversion. It prevents active pasted markup
// from reaching the editor; no network or server is involved.
function sanitiseInputHtml(html) {
  if (!html) return "";

  const documentNode = new DOMParser().parseFromString(html, "text/html");
  documentNode
    .querySelectorAll(
      "script, style, meta, link, iframe, object, embed, form, input, button, textarea, select, option, base",
    )
    .forEach((node) => node.remove());

  documentNode.querySelectorAll("*").forEach((element) => {
    if (element.tagName === "IMG") {
      // Images are not converted, so prevent pasted remote URLs from loading.
      element.removeAttribute("src");
      element.removeAttribute("srcset");
    }

    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        name === "contenteditable" ||
        (["href", "src", "xlink:href"].includes(name) &&
          /^(?:javascript|vbscript|data:text\/html)/i.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    });
  });

  return documentNode.body.innerHTML;
}

function normalisePlainText(value) {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeWikiHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripRtfControlWords(value) {
  if (!/^\s*\{\\rtf/i.test(value)) return value;

  return value
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\tab/g, "\t")
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/\\u(-?\d+)\??/g, (_, code) => {
      const number = Number(code);
      return String.fromCharCode(number < 0 ? number + 65536 : number);
    })
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export {
  convertHtmlToMediaWiki,
  escapeHtml,
  normalisePlainText,
  sanitiseInputHtml,
  stripRtfControlWords,
};
