(() => {
  "use strict";

  // Conversion settings are isolated here; Alpine owns all UI and persistence.
  const defaultSettings = {
    preserveLineBreaks: false,
    externalLinks: true,
    tableClass: "wikitable",
  };

  let activeSettings = { ...defaultSettings };

  // Run untrusted rich HTML through sanitisation and the recursive converter.
  function convertHtmlToMediaWiki(html) {
    const parser = new DOMParser();
    const documentNode = parser.parseFromString(
      sanitiseInputHtml(html),
      "text/html",
    );

    removeNonContentNodes(documentNode.body);
    normaliseWordLists(documentNode.body);

    const context = {
      listDepth: 0,
      inPre: false,
      inTable: false,
    };

    let output = convertChildren(documentNode.body, context);

    output = decodeCommonEntities(output);
    output = cleanMediaWikiOutput(output);

    return output;
  }

  function convertChildren(parent, context) {
    return [...parent.childNodes]
      .map((node) => convertNode(node, context))
      .join("");
  }

  // Central DOM-node dispatcher. Context flags keep block rules scoped to
  // lists, tables, and preformatted text.
  function convertNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      return convertTextNode(node, context);
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tag = element.tagName.toLowerCase();

    if (["script", "style", "meta", "link", "noscript", "svg"].includes(tag)) {
      return "";
    }

    if (tag === "br") {
      return context.inPre
        ? "\n"
        : activeSettings.preserveLineBreaks
          ? "<br />\n"
          : "\n";
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const marker = "=".repeat(level);
      const content = cleanInlineMarkup(convertChildren(element, context));

      return content ? `\n${marker} ${content} ${marker}\n\n` : "";
    }

    if (tag === "p") {
      return convertParagraph(element, context);
    }

    if (tag === "div" || tag === "section" || tag === "article") {
      const content = convertChildren(element, context).trim();

      return content ? `\n${content}\n\n` : "";
    }

    if (tag === "strong" || tag === "b") {
      const content = cleanInlineMarkup(convertChildren(element, context));
      return content ? `'''${content}'''` : "";
    }

    if (tag === "em" || tag === "i") {
      const content = cleanInlineMarkup(convertChildren(element, context));
      return content ? `''${content}''` : "";
    }

    if (tag === "u" || isUnderlineElement(element)) {
      const content = cleanInlineMarkup(convertChildren(element, context));
      return content ? `<u>${content}</u>` : "";
    }

    if (
      tag === "s" ||
      tag === "strike" ||
      tag === "del" ||
      isStrikethroughElement(element)
    ) {
      const content = cleanInlineMarkup(convertChildren(element, context));
      return content ? `<s>${content}</s>` : "";
    }

    if (tag === "code" && !context.inPre) {
      const content = normaliseInlineWhitespace(element.textContent);
      return content ? `<code>${escapeWikiHtml(content)}</code>` : "";
    }

    if (tag === "pre") {
      const content = normaliseNewlines(element.textContent).replace(
        /^\n+|\n+$/g,
        "",
      );

      if (!content) {
        return "";
      }

      return `\n<pre>${escapeWikiHtml(content)}</pre>\n\n`;
    }

    if (tag === "blockquote") {
      const content = cleanMediaWikiOutput(convertChildren(element, context))
        .split("\n")
        .filter(Boolean)
        .map((line) => `: ${line}`)
        .join("\n");

      return content ? `\n${content}\n\n` : "";
    }

    if (tag === "a") {
      return convertLink(element, context);
    }

    if (tag === "ul" || tag === "ol") {
      return convertList(element, context);
    }

    if (tag === "table") {
      return convertTable(element, context);
    }

    if (tag === "img") {
      const alt = normaliseInlineWhitespace(
        element.getAttribute("alt") || element.getAttribute("title") || "",
      );

      return alt
        ? `<!-- Image omitted: ${escapeWikiComment(alt)} -->`
        : "<!-- Image omitted -->";
    }

    if (tag === "hr") {
      return "\n----\n\n";
    }

    if (tag === "sup") {
      const content = cleanInlineMarkup(convertChildren(element, context));
      return content ? `<sup>${content}</sup>` : "";
    }

    if (tag === "sub") {
      const content = cleanInlineMarkup(convertChildren(element, context));
      return content ? `<sub>${content}</sub>` : "";
    }

    return convertChildren(element, context);
  }

  function convertTextNode(node, context) {
    const parentTag = node.parentElement?.tagName?.toLowerCase() ?? "";

    if (context.inPre || parentTag === "pre") {
      return normaliseNewlines(node.nodeValue || "");
    }

    return normaliseInlineWhitespace(node.nodeValue || "");
  }

  function convertParagraph(element, context) {
    const headingLevel = detectWordHeadingLevel(element);

    if (headingLevel) {
      const marker = "=".repeat(headingLevel);
      const content = cleanInlineMarkup(convertChildren(element, context));
      return content ? `\n${marker} ${content} ${marker}\n\n` : "";
    }

    const listInfo = detectWordListParagraph(element);

    if (listInfo) {
      const content = cleanInlineMarkup(
        convertChildren(element, context).replace(
          /^[\s\u00a0]*(?:[•·▪◦●○■□–—-]|\(?\d+[.)]|\(?[a-zA-Z][.)])\s*/u,
          "",
        ),
      );

      if (!content) {
        return "";
      }

      const marker = listInfo.type === "ordered" ? "#" : "*";
      return `${marker.repeat(Math.max(1, listInfo.level))} ${content}\n`;
    }

    const content = cleanInlineMarkup(convertChildren(element, context));

    return content ? `\n${content}\n\n` : "\n";
  }

  function convertLink(element, context) {
    const href = (element.getAttribute("href") || "").trim();
    const label = cleanInlineMarkup(convertChildren(element, context));
    const fallback = label || href;

    if (!href) {
      return fallback;
    }

    if (/^(javascript|data|vbscript):/i.test(href)) {
      return fallback;
    }

    if (/^mailto:/i.test(href)) {
      const address = href.replace(/^mailto:/i, "").split("?")[0];
      return activeSettings.externalLinks
        ? `[mailto:${address}${label && label !== address ? ` ${label}` : ""}]`
        : fallback;
    }

    if (/^(https?:|ftp:)/i.test(href)) {
      if (!activeSettings.externalLinks) {
        return fallback;
      }

      return label && label !== href ? `[${href} ${label}]` : `[${href}]`;
    }

    if (href.startsWith("#")) {
      const anchor = href.slice(1);
      return label ? `[[#${anchor}|${label}]]` : `[[#${anchor}]]`;
    }

    return fallback;
  }

  function convertList(listElement, context, prefix = "") {
    const listTag = listElement.tagName.toLowerCase();
    const ownMarker = listTag === "ol" ? "#" : "*";
    const currentPrefix = `${prefix}${ownMarker}`;
    const lines = [];

    const listItems = [...listElement.children].filter(
      (child) => child.tagName.toLowerCase() === "li",
    );

    listItems.forEach((item) => {
      const inlineParts = [];
      const nestedLists = [];

      [...item.childNodes].forEach((child) => {
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          ["ul", "ol"].includes(child.tagName.toLowerCase())
        ) {
          nestedLists.push(child);
        } else {
          inlineParts.push(
            convertNode(child, {
              ...context,
              listDepth: context.listDepth + 1,
            }),
          );
        }
      });

      const content = cleanInlineMarkup(inlineParts.join(""));
      lines.push(`${currentPrefix}${content ? ` ${content}` : ""}`);

      nestedLists.forEach((nestedList) => {
        const nestedOutput = convertList(
          nestedList,
          {
            ...context,
            listDepth: context.listDepth + 1,
          },
          currentPrefix,
        ).trimEnd();

        if (nestedOutput) {
          lines.push(nestedOutput);
        }
      });
    });

    return lines.length ? `\n${lines.join("\n")}\n\n` : "";
  }

  function convertTable(tableElement, context) {
    const rows = [...tableElement.querySelectorAll("tr")].filter(
      (row) => row.closest("table") === tableElement,
    );

    if (!rows.length) {
      return "";
    }

    const classSuffix = activeSettings.tableClass
      ? ` class="${activeSettings.tableClass}"`
      : "";

    const lines = [`{|${classSuffix}`];

    const caption = tableElement.querySelector(":scope > caption");

    if (caption) {
      const captionText = cleanInlineMarkup(
        convertChildren(caption, {
          ...context,
          inTable: true,
        }),
      );

      if (captionText) {
        lines.push(`|+ ${captionText}`);
      }
    }

    rows.forEach((row) => {
      lines.push("|-");

      const cells = [...row.children].filter((child) =>
        ["td", "th"].includes(child.tagName.toLowerCase()),
      );

      cells.forEach((cell) => {
        const isHeader = cell.tagName.toLowerCase() === "th";
        const marker = isHeader ? "!" : "|";
        const attributes = convertTableCellAttributes(cell);
        const content = cleanTableCellContent(
          convertChildren(cell, {
            ...context,
            inTable: true,
          }),
        );

        lines.push(
          attributes
            ? `${marker} ${attributes} | ${content}`
            : `${marker} ${content}`,
        );
      });
    });

    lines.push("|}");

    return `\n${lines.join("\n")}\n\n`;
  }

  function convertTableCellAttributes(cell) {
    const attributes = [];

    const colspan = Number.parseInt(cell.getAttribute("colspan") || "", 10);
    const rowspan = Number.parseInt(cell.getAttribute("rowspan") || "", 10);

    if (Number.isFinite(colspan) && colspan > 1) {
      attributes.push(`colspan="${colspan}"`);
    }

    if (Number.isFinite(rowspan) && rowspan > 1) {
      attributes.push(`rowspan="${rowspan}"`);
    }

    return attributes.join(" ");
  }

  function cleanTableCellContent(content) {
    return cleanInlineMarkup(content)
      .replace(/\n{2,}/g, "<br />")
      .replace(/\n/g, activeSettings.preserveLineBreaks ? "<br />" : " ")
      .trim();
  }

  // Remove active content and unsafe URL/event attributes before pasted HTML
  // is stored or converted.
  function sanitiseInputHtml(html) {
    if (!html) {
      return "";
    }

    const parser = new DOMParser();
    const documentNode = parser.parseFromString(html, "text/html");

    documentNode
      .querySelectorAll(
        "script, style, meta, link, iframe, object, embed, form, input, button, textarea, select, option, base",
      )
      .forEach((node) => node.remove());

    documentNode.querySelectorAll("*").forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = attribute.value;

        if (
          name.startsWith("on") ||
          name === "srcdoc" ||
          name === "contenteditable"
        ) {
          element.removeAttribute(attribute.name);
          return;
        }

        if (
          ["href", "src", "xlink:href"].includes(name) &&
          /^(javascript|vbscript|data:text\/html)/i.test(value.trim())
        ) {
          element.removeAttribute(attribute.name);
        }
      });
    });

    return documentNode.body.innerHTML;
  }

  function removeNonContentNodes(root) {
    root
      .querySelectorAll(
        "script, style, meta, link, noscript, iframe, object, embed, form",
      )
      .forEach((node) => node.remove());

    root.querySelectorAll("*").forEach((element) => {
      if (
        element.tagName.toLowerCase() === "span" &&
        !element.textContent.trim() &&
        !element.querySelector("img, br")
      ) {
        element.remove();
      }
    });
  }

  // Word often represents lists as styled paragraphs, so annotate them before
  // recursive conversion.
  function normaliseWordLists(root) {
    const paragraphs = [...root.querySelectorAll("p")];

    paragraphs.forEach((paragraph) => {
      const info = detectWordListParagraph(paragraph);

      if (info) {
        paragraph.dataset.wikiListType = info.type;
        paragraph.dataset.wikiListLevel = String(info.level);
      }
    });
  }

  function detectWordHeadingLevel(element) {
    const className = element.className || "";
    const styleName = element.getAttribute("style") || "";
    const combined = `${className} ${styleName}`;

    const match =
      combined.match(/\bHeading\s*([1-6])\b/i) ||
      combined.match(/\bMsoHeading([1-6])\b/i);

    return match ? Number(match[1]) : 0;
  }

  // Infer Word list type and depth from CSS metadata, indentation, and markers.
  function detectWordListParagraph(element) {
    if (element.dataset.wikiListType) {
      return {
        type: element.dataset.wikiListType,
        level: Number(element.dataset.wikiListLevel || 1),
      };
    }

    const className = element.className || "";
    const style = element.getAttribute("style") || "";
    const text = element.textContent.trim();
    const isWordList =
      /\bMsoListParagraph\b/i.test(className) || /mso-list\s*:/i.test(style);

    const bulletMatch = text.match(/^[\s\u00a0]*[•·▪◦●○■□–—-]\s+/u);
    const orderedMatch = text.match(
      /^[\s\u00a0]*(?:\(?\d+[.)]|\(?[a-zA-Z][.)])\s+/,
    );

    if (!isWordList && !bulletMatch && !orderedMatch) {
      return null;
    }

    const levelMatch = style.match(/\blevel(\d+)\b/i);
    const marginMatch = style.match(
      /margin-left\s*:\s*([\d.]+)(pt|px|cm|mm|in)/i,
    );

    let level = levelMatch ? Number(levelMatch[1]) : 1;

    if (!levelMatch && marginMatch) {
      const amount = Number(marginMatch[1]);
      const unit = marginMatch[2].toLowerCase();
      const points =
        unit === "pt"
          ? amount
          : unit === "px"
            ? amount * 0.75
            : unit === "cm"
              ? amount * 28.3465
              : unit === "mm"
                ? amount * 2.83465
                : amount * 72;

      level = Math.max(1, Math.round(points / 36));
    }

    return {
      type: orderedMatch ? "ordered" : "unordered",
      level: Math.min(Math.max(level, 1), 8),
    };
  }

  function isUnderlineElement(element) {
    const style = element.getAttribute("style") || "";
    return /text-decoration(?:-line)?\s*:[^;]*underline/i.test(style);
  }

  function isStrikethroughElement(element) {
    const style = element.getAttribute("style") || "";
    return /text-decoration(?:-line)?\s*:[^;]*line-through/i.test(style);
  }

  function cleanInlineMarkup(value) {
    return value
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{2,}/g, "\n")
      .replace(/^\s+|\s+$/g, "")
      .replace(/'''{6,}/g, "'''")
      .replace(/''{4,}/g, "''");
  }

  function cleanMediaWikiOutput(value) {
    return normaliseNewlines(value)
      .replace(/[ \t]+$/gm, "")
      .replace(/^[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\n+(\{\|)/g, "\n\n$1")
      .replace(/(\|\})\n+/g, "$1\n\n")
      .replace(/^\n+|\n+$/g, "")
      .trim();
  }

  function decodeCommonEntities(value) {
    return value
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  function normaliseInlineWhitespace(value) {
    return value
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v\n]+/g, " ");
  }

  function normalisePlainText(value) {
    return normaliseNewlines(value)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+$/gm, "")
      .trim();
  }

  function normaliseNewlines(value) {
    return String(value).replace(/\r\n?/g, "\n");
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

  function escapeWikiComment(value) {
    return String(value).replace(/--/g, "—");
  }

  function stripRtfControlWords(value) {
    if (!/^\s*\{\\rtf/i.test(value)) {
      return value;
    }

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

  // Keep the public surface small so the engine remains framework-independent.
  window.WikiConverter = Object.freeze({
    convert(html, settings = {}) {
      activeSettings = {
        ...defaultSettings,
        ...settings,
      };

      return convertHtmlToMediaWiki(html);
    },
    escapeHtml,
    normalisePlainText,
    sanitiseInputHtml,
    stripRtfControlWords,
  });
})();
