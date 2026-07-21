(() => {
  "use strict";

  const STORAGE_KEY = "wikiconvert-state-v1";
  const AUTO_CONVERT_DELAY_MS = 450;

  const defaultState = {
    currentView: "converter",
    inputHtml: "",
    inputText: "",
    output: "",
    history: [],
    settings: {
      autoConvert: true,
      preserveLineBreaks: false,
      externalLinks: true,
      tableClass: "wikitable",
      saveHistory: true,
      historyLimit: 10,
    },
  };

  const pageMetadata = {
    converter: {
      title: "MediaWiki Converter",
      subtitle: "Paste or drop formatted content and convert it locally",
    },
    history: {
      title: "Conversion History",
      subtitle: "Review and reuse recent browser-local conversions",
    },
    settings: {
      title: "Settings",
      subtitle: "Configure conversion behaviour and local storage",
    },
    about: {
      title: "About WikiConvert",
      subtitle: "Supported markup, privacy, shortcuts, and limitations",
    },
  };

  const elements = {
    sidebar: document.querySelector("#sidebar"),
    sidebarBackdrop: document.querySelector("#sidebar-backdrop"),
    mobileMenuButton: document.querySelector("#mobile-menu-button"),
    nav: document.querySelector(".sidebar-nav"),
    pageTitle: document.querySelector("#page-title"),
    pageSubtitle: document.querySelector("#page-subtitle"),
    views: [...document.querySelectorAll("[data-view-container]")],

    dropZone: document.querySelector("#drop-zone"),
    dropInstructions: document.querySelector("#drop-instructions"),
    richInput: document.querySelector("#rich-input"),
    pasteButton: document.querySelector("#paste-button"),
    clearInputButton: document.querySelector("#clear-input-button"),
    convertButton: document.querySelector("#convert-button"),
    copyButton: document.querySelector("#copy-button"),
    outputTextarea: document.querySelector("#output-textarea"),
    conversionOverlay: document.querySelector("#conversion-overlay"),

    inputStatus: document.querySelector("#input-status"),
    outputStatus: document.querySelector("#output-status"),
    inputWords: document.querySelector("#input-words"),
    inputChars: document.querySelector("#input-chars"),
    outputLines: document.querySelector("#output-lines"),
    outputChars: document.querySelector("#output-chars"),

    historyList: document.querySelector("#history-list"),
    clearHistoryButton: document.querySelector("#clear-history-button"),

    settingAutoConvert: document.querySelector("#setting-auto-convert"),
    settingPreserveLineBreaks: document.querySelector(
      "#setting-preserve-line-breaks",
    ),
    settingExternalLinks: document.querySelector("#setting-external-links"),
    settingTableClass: document.querySelector("#setting-table-class"),
    settingSaveHistory: document.querySelector("#setting-save-history"),
    settingHistoryLimit: document.querySelector("#setting-history-limit"),
    resetApplicationButton: document.querySelector("#reset-application-button"),

    storageStatus: document.querySelector("#storage-status"),
    toastRegion: document.querySelector("#toast-region"),
  };

  let state = loadState();
  let autoConvertTimer = null;
  let isConverting = false;

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);

      if (!saved) {
        return structuredClone(defaultState);
      }

      const parsed = JSON.parse(saved);

      return {
        ...structuredClone(defaultState),
        ...parsed,
        settings: {
          ...defaultState.settings,
          ...(parsed.settings ?? {}),
        },
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch {
      return structuredClone(defaultState);
    }
  }

  function persistState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      elements.storageStatus.textContent = "State saved locally";
    } catch {
      elements.storageStatus.textContent = "Local storage unavailable";
    }
  }

  function setState(updates, { persist = true } = {}) {
    state = {
      ...state,
      ...updates,
    };

    if (persist) {
      persistState();
    }
  }

  function initialise() {
    hydrateSettings();
    restoreDraft();
    renderHistory();
    switchView(state.currentView || "converter", false);
    updateInputStats();
    updateOutputStats();
    updateButtons();
    bindEvents();
  }

  function hydrateSettings() {
    elements.settingAutoConvert.checked = state.settings.autoConvert;
    elements.settingPreserveLineBreaks.checked =
      state.settings.preserveLineBreaks;
    elements.settingExternalLinks.checked = state.settings.externalLinks;
    elements.settingTableClass.value = state.settings.tableClass;
    elements.settingSaveHistory.checked = state.settings.saveHistory;
    elements.settingHistoryLimit.value = String(state.settings.historyLimit);
  }

  function restoreDraft() {
    if (state.inputHtml || state.inputText) {
      showRichInput();

      if (state.inputHtml) {
        elements.richInput.innerHTML = sanitiseInputHtml(state.inputHtml);
      } else {
        elements.richInput.textContent = state.inputText;
      }
    }

    elements.outputTextarea.value = state.output || "";

    if (state.output) {
      setStatus(elements.outputStatus, "Saved output restored", "success");
    }
  }

  function bindEvents() {
    elements.nav.addEventListener("click", handleNavigation);
    elements.mobileMenuButton.addEventListener("click", toggleMobileMenu);
    elements.sidebarBackdrop.addEventListener("click", closeMobileMenu);

    elements.dropInstructions.addEventListener("click", showAndFocusInput);
    elements.dropInstructions.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showAndFocusInput();
      }
    });

    elements.richInput.addEventListener("input", handleRichInputChange);
    elements.richInput.addEventListener("paste", handleRichInputPaste);

    ["dragenter", "dragover"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, handleDragEnter);
    });

    ["dragleave", "drop"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, handleDragExit);
    });

    elements.dropZone.addEventListener("drop", handleDrop);

    elements.pasteButton.addEventListener("click", pasteFromClipboard);
    elements.clearInputButton.addEventListener("click", clearInput);
    elements.convertButton.addEventListener("click", convertContent);
    elements.copyButton.addEventListener("click", copyOutput);
    elements.outputTextarea.addEventListener("input", handleOutputChange);

    elements.historyList.addEventListener("click", handleHistoryAction);
    elements.clearHistoryButton.addEventListener("click", clearHistory);

    elements.settingAutoConvert.addEventListener("change", updateSettings);
    elements.settingPreserveLineBreaks.addEventListener(
      "change",
      updateSettings,
    );
    elements.settingExternalLinks.addEventListener("change", updateSettings);
    elements.settingTableClass.addEventListener("change", updateSettings);
    elements.settingSaveHistory.addEventListener("change", updateSettings);
    elements.settingHistoryLimit.addEventListener("change", updateSettings);
    elements.resetApplicationButton.addEventListener("click", resetApplication);

    document.addEventListener("keydown", handleKeyboardShortcuts);
    window.addEventListener("resize", () => {
      if (window.innerWidth > 820) {
        closeMobileMenu();
      }
    });
  }

  function handleNavigation(event) {
    const button = event.target.closest("[data-view]");

    if (!button) {
      return;
    }

    switchView(button.dataset.view);
    closeMobileMenu();
  }

  function switchView(viewName, shouldPersist = true) {
    if (!pageMetadata[viewName]) {
      viewName = "converter";
    }

    elements.views.forEach((view) => {
      view.classList.toggle("hidden", view.dataset.viewContainer !== viewName);
    });

    document.querySelectorAll("[data-view]").forEach((button) => {
      const active = button.dataset.view === viewName;
      button.classList.toggle("active", active);

      if (active) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });

    const metadata = pageMetadata[viewName];
    elements.pageTitle.textContent = metadata.title;
    elements.pageSubtitle.textContent = metadata.subtitle;

    setState(
      {
        currentView: viewName,
      },
      {
        persist: shouldPersist,
      },
    );

    if (viewName === "history") {
      renderHistory();
    }
  }

  function toggleMobileMenu() {
    const willOpen = !elements.sidebar.classList.contains("open");
    elements.sidebar.classList.toggle("open", willOpen);
    elements.sidebarBackdrop.classList.toggle("hidden", !willOpen);
    elements.mobileMenuButton.setAttribute("aria-expanded", String(willOpen));
  }

  function closeMobileMenu() {
    elements.sidebar.classList.remove("open");
    elements.sidebarBackdrop.classList.add("hidden");
    elements.mobileMenuButton.setAttribute("aria-expanded", "false");
  }

  function showRichInput() {
    elements.dropInstructions.classList.add("hidden");
    elements.richInput.classList.remove("hidden");
  }

  function showAndFocusInput() {
    showRichInput();
    elements.richInput.focus();
  }

  function handleRichInputChange() {
    const inputHtml = elements.richInput.innerHTML;
    const inputText = normalisePlainText(elements.richInput.innerText);

    setState({
      inputHtml,
      inputText,
    });

    setStatus(
      elements.inputStatus,
      inputText ? "Input updated" : "Waiting for input",
      inputText ? "success" : "",
    );

    updateInputStats();
    updateButtons();
    scheduleAutoConvert();
  }

  function handleRichInputPaste(event) {
    const clipboard = event.clipboardData;

    if (!clipboard) {
      return;
    }

    const html = clipboard.getData("text/html");
    const text = clipboard.getData("text/plain");

    if (!html) {
      return;
    }

    event.preventDefault();

    const cleaned = sanitiseInputHtml(html);
    insertHtmlAtSelection(cleaned || escapeHtml(text));
    handleRichInputChange();
  }

  function handleDragEnter(event) {
    event.preventDefault();
    event.stopPropagation();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }

    elements.dropZone.classList.add("drag-active");
  }

  function handleDragExit(event) {
    event.preventDefault();
    event.stopPropagation();

    if (
      event.type === "dragleave" &&
      elements.dropZone.contains(event.relatedTarget)
    ) {
      return;
    }

    elements.dropZone.classList.remove("drag-active");
  }

  async function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    elements.dropZone.classList.remove("drag-active");

    const transfer = event.dataTransfer;

    if (!transfer) {
      return;
    }

    const html = transfer.getData("text/html");
    const text = transfer.getData("text/plain");

    if (html || text) {
      applyInputContent({
        html,
        text,
      });
      return;
    }

    const files = [...transfer.files];

    if (!files.length) {
      showToast(
        "No supported content was found in the dropped data.",
        "warning",
      );
      return;
    }

    const file = files[0];
    const supportedTextTypes = [
      "text/plain",
      "text/html",
      "text/rtf",
      "application/rtf",
    ];

    if (
      !supportedTextTypes.includes(file.type) &&
      !/\.(txt|html?|rtf)$/i.test(file.name)
    ) {
      showToast(
        "Drop text, HTML, RTF text, or content copied from a rich-text application.",
        "warning",
      );
      return;
    }

    try {
      const fileText = await file.text();

      if (/\.html?$/i.test(file.name) || file.type === "text/html") {
        applyInputContent({
          html: fileText,
          text: "",
        });
      } else {
        applyInputContent({
          html: "",
          text: stripRtfControlWords(fileText),
        });
      }
    } catch {
      showToast("The dropped file could not be read.", "error");
    }
  }

  async function pasteFromClipboard() {
    if (!navigator.clipboard) {
      showAndFocusInput();
      showToast(
        "Use Ctrl+V to paste because direct clipboard access is unavailable.",
        "warning",
      );
      return;
    }

    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        let html = "";
        let text = "";

        for (const item of items) {
          if (item.types.includes("text/html")) {
            const blob = await item.getType("text/html");
            html = await blob.text();
          }

          if (item.types.includes("text/plain")) {
            const blob = await item.getType("text/plain");
            text = await blob.text();
          }

          if (html || text) {
            break;
          }
        }

        if (!html && !text) {
          throw new Error("Clipboard did not contain text");
        }

        applyInputContent({
          html,
          text,
        });
        return;
      }

      const text = await navigator.clipboard.readText();

      if (!text) {
        throw new Error("Clipboard did not contain text");
      }

      applyInputContent({
        html: "",
        text,
      });
    } catch {
      showAndFocusInput();
      showToast(
        "Clipboard permission was not granted. Press Ctrl+V inside the input area.",
        "warning",
      );
    }
  }

  function applyInputContent({ html = "", text = "" }) {
    showRichInput();

    if (html) {
      elements.richInput.innerHTML = sanitiseInputHtml(html);
    } else {
      elements.richInput.textContent = text;
    }

    handleRichInputChange();
    elements.richInput.focus();
  }

  function clearInput() {
    clearTimeout(autoConvertTimer);
    elements.richInput.innerHTML = "";
    elements.richInput.classList.add("hidden");
    elements.dropInstructions.classList.remove("hidden");
    elements.outputTextarea.value = "";

    setState({
      inputHtml: "",
      inputText: "",
      output: "",
    });

    setStatus(elements.inputStatus, "Waiting for input");
    setStatus(elements.outputStatus, "No conversion yet");
    updateInputStats();
    updateOutputStats();
    updateButtons();
    showToast("Input and output cleared.", "info");
  }

  function scheduleAutoConvert() {
    clearTimeout(autoConvertTimer);

    if (!state.settings.autoConvert || !state.inputText.trim()) {
      return;
    }

    autoConvertTimer = window.setTimeout(() => {
      convertContent();
    }, AUTO_CONVERT_DELAY_MS);
  }

  async function convertContent() {
    if (isConverting || !state.inputText.trim()) {
      return;
    }

    isConverting = true;
    updateButtons();
    elements.conversionOverlay.classList.remove("hidden");
    setStatus(elements.outputStatus, "Converting content");

    await nextPaint();

    try {
      const sourceHtml =
        state.inputHtml || `<p>${escapeHtml(state.inputText)}</p>`;

      const output = convertHtmlToMediaWiki(sourceHtml);

      elements.outputTextarea.value = output;

      setState({
        output,
      });

      updateOutputStats();

      if (output) {
        setStatus(elements.outputStatus, "Conversion complete", "success");
        saveHistoryEntry(output);
      } else {
        setStatus(
          elements.outputStatus,
          "No convertible content was found",
          "warning",
        );
      }
    } catch (error) {
      console.error(error);
      setStatus(elements.outputStatus, "Conversion failed", "error");
      showToast(
        "The content could not be converted. Try pasting it as plain text.",
        "error",
      );
    } finally {
      isConverting = false;
      elements.conversionOverlay.classList.add("hidden");
      updateButtons();
    }
  }

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
        : state.settings.preserveLineBreaks
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
      return state.settings.externalLinks
        ? `[mailto:${address}${label && label !== address ? ` ${label}` : ""}]`
        : fallback;
    }

    if (/^(https?:|ftp:)/i.test(href)) {
      if (!state.settings.externalLinks) {
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

    const classSuffix = state.settings.tableClass
      ? ` class="${state.settings.tableClass}"`
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
      .replace(/\n/g, state.settings.preserveLineBreaks ? "<br />" : " ")
      .trim();
  }

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

  function insertHtmlAtSelection(html) {
    const selection = window.getSelection();

    if (!selection || !selection.rangeCount) {
      elements.richInput.insertAdjacentHTML("beforeend", html);
      return;
    }

    const range = selection.getRangeAt(0);

    if (!elements.richInput.contains(range.commonAncestorContainer)) {
      elements.richInput.insertAdjacentHTML("beforeend", html);
      return;
    }

    range.deleteContents();

    const fragment = range.createContextualFragment(html);
    const lastNode = fragment.lastChild;
    range.insertNode(fragment);

    if (lastNode) {
      range.setStartAfter(lastNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function handleOutputChange() {
    setState({
      output: elements.outputTextarea.value,
    });

    setStatus(elements.outputStatus, "Output edited", "success");
    updateOutputStats();
    updateButtons();
  }

  async function copyOutput() {
    const output = elements.outputTextarea.value;

    if (!output) {
      return;
    }

    try {
      await navigator.clipboard.writeText(output);
      setStatus(elements.outputStatus, "Copied to clipboard", "success");
      showToast("MediaWiki markup copied to the clipboard.", "success");
    } catch {
      elements.outputTextarea.focus();
      elements.outputTextarea.select();

      const copied = document.execCommand("copy");

      if (copied) {
        setStatus(elements.outputStatus, "Copied to clipboard", "success");
        showToast("MediaWiki markup copied to the clipboard.", "success");
      } else {
        setStatus(elements.outputStatus, "Select and copy manually", "warning");
        showToast(
          "Automatic copying is unavailable. The output has been selected.",
          "warning",
        );
      }
    }
  }

  function saveHistoryEntry(output) {
    if (!state.settings.saveHistory || !output.trim()) {
      return;
    }

    const existing = state.history[0];

    if (existing?.output === output) {
      return;
    }

    const entry = {
      id:
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
      title: deriveHistoryTitle(output),
      inputHtml: state.inputHtml,
      inputText: state.inputText,
      output,
    };

    const history = [entry, ...state.history].slice(
      0,
      state.settings.historyLimit,
    );

    setState({
      history,
    });
  }

  function deriveHistoryTitle(output) {
    const firstMeaningfulLine =
      output
        .split("\n")
        .map((line) =>
          line
            .replace(/^={1,6}\s*|\s*={1,6}$/g, "")
            .replace(/^[*#:;]+\s*/, "")
            .replace(/'{2,3}/g, "")
            .replace(/<[^>]+>/g, "")
            .trim(),
        )
        .find(Boolean) || "Untitled conversion";

    return firstMeaningfulLine.length > 70
      ? `${firstMeaningfulLine.slice(0, 67)}...`
      : firstMeaningfulLine;
  }

  function renderHistory() {
    elements.historyList.textContent = "";
    elements.clearHistoryButton.disabled = state.history.length === 0;

    if (!state.history.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No conversion history has been saved.";
      elements.historyList.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    state.history.forEach((entry) => {
      const article = document.createElement("article");
      article.className = "history-item";
      article.dataset.historyId = entry.id;

      const header = document.createElement("div");
      header.className = "history-item-header";

      const meta = document.createElement("div");
      meta.className = "history-meta";

      const title = document.createElement("h3");
      title.textContent = entry.title;

      const timestamp = document.createElement("p");
      timestamp.textContent = formatDateTime(entry.createdAt);

      meta.append(title, timestamp);

      const actions = document.createElement("div");
      actions.className = "history-actions";

      const restoreButton = createIconButton("Restore", "restore", "R");
      const copyButton = createIconButton("Copy", "copy", "C");
      const deleteButton = createIconButton("Delete", "delete", "×", "danger");

      actions.append(restoreButton, copyButton, deleteButton);
      header.append(meta, actions);

      const preview = document.createElement("pre");
      preview.className = "history-preview";
      preview.textContent = entry.output;

      article.append(header, preview);
      fragment.append(article);
    });

    elements.historyList.append(fragment);
  }

  function createIconButton(label, action, text, extraClass = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `icon-button ${extraClass}`.trim();
    button.dataset.historyAction = action;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.textContent = text;
    return button;
  }

  async function handleHistoryAction(event) {
    const button = event.target.closest("[data-history-action]");
    const item = event.target.closest("[data-history-id]");

    if (!button || !item) {
      return;
    }

    const entry = state.history.find(
      (historyEntry) => historyEntry.id === item.dataset.historyId,
    );

    if (!entry) {
      return;
    }

    const action = button.dataset.historyAction;

    if (action === "restore") {
      setState({
        inputHtml: entry.inputHtml || "",
        inputText: entry.inputText || "",
        output: entry.output,
      });

      restoreDraft();
      updateInputStats();
      updateOutputStats();
      updateButtons();
      switchView("converter");
      showToast("Conversion restored.", "success");
      return;
    }

    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(entry.output);
        showToast("History output copied to the clipboard.", "success");
      } catch {
        showToast("Clipboard access is unavailable.", "error");
      }
      return;
    }

    if (action === "delete") {
      const history = state.history.filter(
        (historyEntry) => historyEntry.id !== entry.id,
      );

      setState({
        history,
      });

      renderHistory();
      showToast("History entry deleted.", "info");
    }
  }

  function clearHistory() {
    if (!state.history.length) {
      return;
    }

    setState({
      history: [],
    });

    renderHistory();
    showToast("Conversion history cleared.", "info");
  }

  function updateSettings() {
    const settings = {
      autoConvert: elements.settingAutoConvert.checked,
      preserveLineBreaks: elements.settingPreserveLineBreaks.checked,
      externalLinks: elements.settingExternalLinks.checked,
      tableClass: elements.settingTableClass.value,
      saveHistory: elements.settingSaveHistory.checked,
      historyLimit: Number(elements.settingHistoryLimit.value),
    };

    const history = state.history.slice(0, settings.historyLimit);

    setState({
      settings,
      history,
    });

    renderHistory();

    if (state.inputText.trim() && settings.autoConvert) {
      scheduleAutoConvert();
    }

    showToast("Settings saved locally.", "success");
  }

  function resetApplication() {
    localStorage.removeItem(STORAGE_KEY);
    state = structuredClone(defaultState);

    clearTimeout(autoConvertTimer);

    elements.richInput.innerHTML = "";
    elements.richInput.classList.add("hidden");
    elements.dropInstructions.classList.remove("hidden");
    elements.outputTextarea.value = "";

    hydrateSettings();
    renderHistory();
    updateInputStats();
    updateOutputStats();
    updateButtons();
    setStatus(elements.inputStatus, "Waiting for input");
    setStatus(elements.outputStatus, "No conversion yet");
    switchView("converter");
    persistState();

    showToast("Application data reset.", "info");
  }

  function updateInputStats() {
    const text = normalisePlainText(
      elements.richInput.innerText || state.inputText || "",
    );
    const words = countWords(text);

    elements.inputWords.textContent = `${words} ${
      words === 1 ? "word" : "words"
    }`;
    elements.inputChars.textContent = `${text.length} ${
      text.length === 1 ? "character" : "characters"
    }`;
  }

  function updateOutputStats() {
    const output = elements.outputTextarea.value;
    const lines = output ? output.split("\n").length : 0;

    elements.outputLines.textContent = `${lines} ${
      lines === 1 ? "line" : "lines"
    }`;
    elements.outputChars.textContent = `${output.length} ${
      output.length === 1 ? "character" : "characters"
    }`;
  }

  function updateButtons() {
    const hasInput = Boolean(state.inputText.trim());
    const hasOutput = Boolean(elements.outputTextarea.value);

    elements.convertButton.disabled = !hasInput || isConverting;
    elements.copyButton.disabled = !hasOutput || isConverting;
    elements.clearInputButton.disabled =
      !hasInput && !elements.outputTextarea.value;
  }

  function countWords(value) {
    const matches = value.trim().match(/\S+/g);
    return matches ? matches.length : 0;
  }

  function setStatus(element, message, type = "") {
    element.textContent = message;
    element.className = `status-message ${type}`.trim();
  }

  function formatDateTime(isoValue) {
    const date = new Date(isoValue);

    if (Number.isNaN(date.getTime())) {
      return "Unknown date";
    }

    return new Intl.DateTimeFormat("en-AU", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function showToast(message, type = "info", duration = 3200) {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.textContent = message;

    elements.toastRegion.append(toast);

    window.setTimeout(() => {
      toast.remove();
    }, duration);
  }

  function handleKeyboardShortcuts(event) {
    const modifier = event.ctrlKey || event.metaKey;

    if (!modifier) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      convertContent();
      return;
    }

    if (event.shiftKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copyOutput();
      return;
    }

    if (event.shiftKey && event.key.toLowerCase() === "v") {
      event.preventDefault();
      switchView("converter");
      showAndFocusInput();
    }
  }

  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }

  initialise();
})();
