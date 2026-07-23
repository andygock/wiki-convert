(() => {
  "use strict";

  // All application data is deliberately browser-local. Bumping this key creates
  // a clean storage namespace when the saved-state schema changes.
  const STORAGE_KEY = "wikiconvert-state-v1";
  // Debounce typing so auto-convert runs only after the user pauses briefly.
  const AUTO_CONVERT_DELAY_MS = 450;

  // This is both the first-run state and the schema fallback for older/corrupt
  // saved data. Keep every user-persisted field represented here.
  const defaultState = {
    currentView: "converter",
    inputHtml: "",
    inputText: "",
    output: "",
    outputHeadingBase: "",
    headingLevelOffset: 0,
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

  // View-specific text is centralised so navigation only needs a view name.
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

  // Cache every DOM dependency once. The rest of the script refers to this map
  // instead of repeatedly querying the document.
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
    editorContainer: document.querySelector("#editor-container"),
    richInput: document.querySelector("#rich-input"),
    pasteButton: document.querySelector("#paste-button"),
    clearInputButton: document.querySelector("#clear-input-button"),
    increaseHeadingLevelButton: document.querySelector(
      "#increase-heading-level-button",
    ),
    resetHeadingLevelButton: document.querySelector(
      "#reset-heading-level-button",
    ),
    decreaseHeadingLevelButton: document.querySelector(
      "#decrease-heading-level-button",
    ),
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

  // Runtime-only flags are not stored: a page reload must never resume an
  // in-progress conversion or a stale debounce timer.
  let state = loadState();
  let autoConvertTimer = null;
  let isConverting = false;
  let quill = null;

  // Read and validate the local draft, merging it onto the current defaults.
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

  // Persist the complete state and reflect whether browser storage succeeded.
  function persistState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      elements.storageStatus.textContent = "State saved locally";
    } catch {
      elements.storageStatus.textContent = "Local storage unavailable";
    }
  }

  // Apply a shallow state update; callers can suppress storage during startup.
  function setState(updates, { persist = true } = {}) {
    state = {
      ...state,
      ...updates,
    };

    if (persist) {
      persistState();
    }
  }

  // Restore UI from state, calculate derived UI, then attach event handlers.
  function initialise() {
    initialiseQuill();
    hydrateSettings();
    restoreDraft();
    renderHistory();
    switchView(state.currentView || "converter", false);
    updateInputStats();
    updateOutputStats();
    updateButtons();
    bindEvents();
  }

  // Build the Quill editor with the formats supported by the converter.
  function initialiseQuill() {
    quill = new Quill(elements.richInput, {
      theme: "snow",
      placeholder: "Paste or type rich content here...",
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, 4, 5, 6, false] }],
          ["bold", "italic", "underline", "strike"],
          ["blockquote", "code-block"],
          [{ list: "ordered" }, { list: "bullet" }],
          ["link", "clean"],
        ],
      },
    });

    quill.root.setAttribute("aria-label", "Rich text input");
    quill.root.setAttribute("role", "textbox");
    quill.root.setAttribute("aria-multiline", "true");
    quill.root.setAttribute("spellcheck", "true");
  }

  // Copy persisted settings into the settings form controls.
  function hydrateSettings() {
    elements.settingAutoConvert.checked = state.settings.autoConvert;
    elements.settingPreserveLineBreaks.checked =
      state.settings.preserveLineBreaks;
    elements.settingExternalLinks.checked = state.settings.externalLinks;
    elements.settingTableClass.value = state.settings.tableClass;
    elements.settingSaveHistory.checked = state.settings.saveHistory;
    elements.settingHistoryLimit.value = String(state.settings.historyLimit);
  }

  // Rebuild the editable rich input and output textarea from a saved draft.
  function restoreDraft() {
    if (state.inputHtml || state.inputText) {
      showRichInput();

      if (state.inputHtml) {
        setEditorHtml(state.inputHtml);
      } else {
        quill.setText(state.inputText, "silent");
      }
    }

    elements.outputTextarea.value = state.output || "";

    if (state.output) {
      setStatus(elements.outputStatus, "Saved output restored", "success");
    }
  }

  // Register all delegated navigation, editor, clipboard, history, and shortcut handlers.
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

    quill.on("text-change", handleRichInputChange);
    quill.root.addEventListener("paste", handleRichInputPaste, {
      capture: true,
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, handleDragEnter);
    });

    ["dragleave", "drop"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, handleDragExit);
    });

    elements.dropZone.addEventListener("drop", handleDrop);

    elements.pasteButton.addEventListener("click", pasteFromClipboard);
    elements.clearInputButton.addEventListener("click", clearInput);
    elements.increaseHeadingLevelButton.addEventListener("click", () => {
      adjustHeadingLevels(1);
    });
    elements.resetHeadingLevelButton.addEventListener("click", () => {
      resetHeadingLevels();
    });
    elements.decreaseHeadingLevelButton.addEventListener("click", () => {
      adjustHeadingLevels(-1);
    });
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

  // Use event delegation to identify a clicked view button in the sidebar.
  function handleNavigation(event) {
    const button = event.target.closest("[data-view]");

    if (!button) {
      return;
    }

    switchView(button.dataset.view);
    closeMobileMenu();
  }

  // Show exactly one view and synchronise nav accessibility state and page heading.
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

  // Toggle the small-screen sidebar and its backdrop as a single UI state.
  function toggleMobileMenu() {
    const willOpen = !elements.sidebar.classList.contains("open");
    elements.sidebar.classList.toggle("open", willOpen);
    elements.sidebarBackdrop.classList.toggle("hidden", !willOpen);
    elements.mobileMenuButton.setAttribute("aria-expanded", String(willOpen));
  }

  // Close the small-screen sidebar, including its accessibility state.
  function closeMobileMenu() {
    elements.sidebar.classList.remove("open");
    elements.sidebarBackdrop.classList.add("hidden");
    elements.mobileMenuButton.setAttribute("aria-expanded", "false");
  }

  // Replace the empty-state instructions with the contenteditable input.
  function showRichInput() {
    elements.dropInstructions.classList.add("hidden");
    elements.editorContainer.classList.remove("hidden");
  }

  // Reveal the editor and place the typing caret in it.
  function showAndFocusInput() {
    showRichInput();
    quill.focus();
  }

  // Save both rich and plain representations, then refresh all input-derived UI.
  function handleRichInputChange() {
    const inputText = normalisePlainText(quill.getText());
    const inputHtml = inputText ? quill.root.innerHTML : "";

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

  // Prefer sanitised HTML on paste so inline formatting survives conversion safely.
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
    event.stopImmediatePropagation();

    const cleaned = sanitiseInputHtml(html);
    insertHtmlAtSelection(cleaned || escapeHtml(text));
  }

  // Allow a drop and give users visual feedback while data is over the target.
  function handleDragEnter(event) {
    event.preventDefault();
    event.stopPropagation();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }

    elements.dropZone.classList.add("drag-active");
  }

  // Remove drag feedback only when the pointer actually leaves the drop zone.
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

  // Accept dropped clipboard-like data first, otherwise read one supported text file.
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

  // Read rich clipboard formats when permission permits; otherwise guide manual paste.
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

  // Put supplied content in the editor, choosing HTML when it is available.
  function applyInputContent({ html = "", text = "" }) {
    showRichInput();

    if (html) {
      setEditorHtml(html);
    } else {
      quill.setText(text, "silent");
    }

    handleRichInputChange();
    quill.focus();
  }

  // Clear both editor/output and cancel pending automatic work.
  function clearInput() {
    clearTimeout(autoConvertTimer);
    quill.setText("", "silent");
    elements.editorContainer.classList.add("hidden");
    elements.dropInstructions.classList.remove("hidden");
    elements.outputTextarea.value = "";

    setState({
      inputHtml: "",
      inputText: "",
      output: "",
      outputHeadingBase: "",
      headingLevelOffset: 0,
    });

    setStatus(elements.inputStatus, "Waiting for input");
    setStatus(elements.outputStatus, "No conversion yet");
    updateInputStats();
    updateOutputStats();
    updateButtons();
    showToast("Input and output cleared.", "info");
  }

  // Debounce auto-conversion; empty input and disabled settings never schedule it.
  function scheduleAutoConvert() {
    clearTimeout(autoConvertTimer);

    if (!state.settings.autoConvert || !state.inputText.trim()) {
      return;
    }

    autoConvertTimer = window.setTimeout(() => {
      convertContent();
    }, AUTO_CONVERT_DELAY_MS);
  }

  // Convert the current draft once, keeping the overlay visible for at least one paint.
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
        outputHeadingBase: output,
        headingLevelOffset: 0,
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

  // Conversion pipeline: parse the untrusted fragment, discard non-content,
  // annotate Word-specific structures, walk the DOM, then tidy the result.
  function convertHtmlToMediaWiki(html) {
    const parser = new DOMParser();
    const documentNode = parser.parseFromString(
      sanitiseInputHtml(html),
      "text/html",
    );

    removeNonContentNodes(documentNode.body);
    normaliseWordLists(documentNode.body);

    // Context travels through the recursive walk. It changes how text, breaks,
    // and nested structures are rendered without modifying the source DOM.
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

  // Convert direct children in document order, preserving their inline sequence.
  function convertChildren(parent, context) {
    return [...parent.childNodes]
      .map((node) => convertNode(node, context))
      .join("");
  }

  // Dispatch one DOM node to its MediaWiki equivalent; unknown containers unwrap.
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

    // Line breaks inside <pre> are literal. Elsewhere the setting determines
    // whether a visible MediaWiki HTML break is needed.
    if (tag === "br") {
      return context.inPre
        ? "\n"
        : state.settings.preserveLineBreaks
          ? "<br />\n"
          : "\n";
    }

    // HTML heading numbers map directly to the corresponding count of '='.
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

    // Images cannot be reliably converted to wiki file references, so retain
    // useful alt text as a harmless comment rather than silently losing it.
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

  // Preserve preformatted text; otherwise collapse HTML whitespace to inline text.
  function convertTextNode(node, context) {
    const parentTag = node.parentElement?.tagName?.toLowerCase() ?? "";

    if (context.inPre || parentTag === "pre") {
      return normaliseNewlines(node.nodeValue || "");
    }

    return normaliseInlineWhitespace(node.nodeValue || "");
  }

  // Handle ordinary paragraphs plus Microsoft Word heading/list conventions.
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

  // Produce safe external/anchor links, respecting the external-links preference.
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

  // Recursively render HTML lists; concatenated markers represent nesting in MediaWiki.
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

      // Convert the item's own text separately so nested lists start on later lines.
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

  // Convert only rows owned by this table, preventing nested tables from leaking in.
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

  // Preserve supported structural cell attributes in MediaWiki table syntax.
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

  // Make multiline cell content safe on a single MediaWiki table-cell line.
  function cleanTableCellContent(content) {
    return cleanInlineMarkup(content)
      .replace(/\n{2,}/g, "<br />")
      .replace(/\n/g, state.settings.preserveLineBreaks ? "<br />" : " ")
      .trim();
  }

  // Remove executable/interactive markup and unsafe URL schemes before DOM insertion.
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

  // Second defensive cleanup after parsing, also dropping empty formatting spans.
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

  // Mark Word-style list paragraphs so paragraph conversion can render list markers.
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

  // Infer Word heading level from class/style names emitted by Office HTML.
  function detectWordHeadingLevel(element) {
    const className = element.className || "";
    const styleName = element.getAttribute("style") || "";
    const combined = `${className} ${styleName}`;

    const match =
      combined.match(/\bHeading\s*([1-6])\b/i) ||
      combined.match(/\bMsoHeading([1-6])\b/i);

    return match ? Number(match[1]) : 0;
  }

  // Identify Word or visibly-prefixed list paragraphs and estimate their nesting level.
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

  // Detect presentational underline styles that do not use a <u> element.
  function isUnderlineElement(element) {
    const style = element.getAttribute("style") || "";
    return /text-decoration(?:-line)?\s*:[^;]*underline/i.test(style);
  }

  // Detect presentational strike styles that do not use semantic strike tags.
  function isStrikethroughElement(element) {
    const style = element.getAttribute("style") || "";
    return /text-decoration(?:-line)?\s*:[^;]*line-through/i.test(style);
  }

  // Normalise whitespace and accidental repeated apostrophe markup in inline output.
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

  // Apply document-level spacing rules after every node has been converted.
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

  // Decode the small safe entity set that can remain after HTML serialisation.
  function decodeCommonEntities(value) {
    return value
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  // Collapse all inline whitespace (including newlines) to one normal space.
  function normaliseInlineWhitespace(value) {
    return value
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v\n]+/g, " ");
  }

  // Produce a stable plain-text form for state, statistics, and empty checks.
  function normalisePlainText(value) {
    return normaliseNewlines(value)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+$/gm, "")
      .trim();
  }

  // Convert Windows and legacy Mac line endings to the single internal form.
  function normaliseNewlines(value) {
    return String(value).replace(/\r\n?/g, "\n");
  }

  // Escape text before it is used as an HTML fallback source fragment.
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Escape only characters that could terminate/change HTML embedded in wiki markup.
  function escapeWikiHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Keep image-alt comments valid by removing the MediaWiki comment terminator.
  function escapeWikiComment(value) {
    return String(value).replace(/--/g, "—");
  }

  // Best-effort plain-text extraction for dropped RTF; this is not a full RTF parser.
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

  // Insert cleaned paste HTML through Quill so its document model stays in sync.
  function insertHtmlAtSelection(html) {
    const range = quill.getSelection(true) ?? {
      index: Math.max(0, quill.getLength() - 1),
      length: 0,
    };

    if (range.length) {
      quill.deleteText(range.index, range.length, "user");
    }

    quill.clipboard.dangerouslyPasteHTML(range.index, html, "user");
  }

  // Replace the complete Quill document with sanitised HTML without firing edits.
  function setEditorHtml(html) {
    quill.clipboard.dangerouslyPasteHTML(sanitiseInputHtml(html), "silent");
  }

  // Treat manual output edits as the current saved draft rather than overwriting them.
  function handleOutputChange() {
    const output = elements.outputTextarea.value;

    setState({
      output,
      outputHeadingBase: output,
      headingLevelOffset: 0,
    });

    setStatus(elements.outputStatus, "Output edited", "success");
    updateOutputStats();
    updateButtons();
  }

  // Shift every MediaWiki heading from the original output, preserving Reset.
  function adjustHeadingLevels(change) {
    const baseOutput = state.outputHeadingBase || elements.outputTextarea.value;
    const levels = getHeadingLevels(baseOutput);

    if (!levels.length) {
      return;
    }

    const minimumOffset = 1 - Math.max(...levels);
    const maximumOffset = 6 - Math.min(...levels);
    const headingLevelOffset = Math.min(
      maximumOffset,
      Math.max(minimumOffset, state.headingLevelOffset + change),
    );
    const output = transposeHeadingLevels(baseOutput, headingLevelOffset);

    elements.outputTextarea.value = output;
    setState({
      output,
      outputHeadingBase: baseOutput,
      headingLevelOffset,
    });

    setStatus(
      elements.outputStatus,
      headingLevelOffset
        ? `Heading levels shifted ${headingLevelOffset > 0 ? "+" : ""}${headingLevelOffset}`
        : "Heading levels reset",
      "success",
    );
    updateOutputStats();
    updateButtons();
  }

  // Restore heading markers to the last conversion or manual output edit.
  function resetHeadingLevels() {
    if (!state.headingLevelOffset) {
      return;
    }

    const output = state.outputHeadingBase || elements.outputTextarea.value;
    elements.outputTextarea.value = output;

    setState({
      output,
      headingLevelOffset: 0,
    });

    setStatus(elements.outputStatus, "Heading levels reset", "success");
    updateOutputStats();
    updateButtons();
  }

  // Return the numeric levels of all valid MediaWiki heading lines.
  function getHeadingLevels(output) {
    return [...String(output).matchAll(/^(={1,6})(.+?)\1[ \t]*$/gm)].map(
      (match) => match[1].length,
    );
  }

  // Rebuild heading markers at an offset while clamping levels from 1 through 6.
  function transposeHeadingLevels(output, offset) {
    return String(output).replace(
      /^(={1,6})(.+?)\1([ \t]*)$/gm,
      (_, markers, content, trailingWhitespace) => {
        const level = Math.min(6, Math.max(1, markers.length + offset));
        const shiftedMarkers = "=".repeat(level);
        return `${shiftedMarkers}${content}${shiftedMarkers}${trailingWhitespace}`;
      },
    );
  }

  // Copy output using the modern Clipboard API, with selection-based legacy fallback.
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

  // Prepend a deduplicated snapshot and enforce the configured local history limit.
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

  // Turn first meaningful markup line into a compact, human-readable history label.
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

  // Recreate the history list with textContent to keep persisted content inert.
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

  // Create consistently labelled history action buttons for delegated click handling.
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

  // Restore, copy, or delete the selected history entry using its stable ID.
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
        outputHeadingBase: entry.output,
        headingLevelOffset: 0,
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

  // Remove all saved conversion snapshots without affecting the active draft.
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

  // Read settings controls, trim history if needed, and trigger any newly enabled auto-convert.
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

  // Return storage and UI to defaults, including deleting the old persisted payload.
  function resetApplication() {
    localStorage.removeItem(STORAGE_KEY);
    state = structuredClone(defaultState);

    clearTimeout(autoConvertTimer);

    quill.setText("", "silent");
    elements.editorContainer.classList.add("hidden");
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

  // Calculate current input word/character totals from the editor's visible text.
  function updateInputStats() {
    const text = normalisePlainText(
      quill?.getText() || state.inputText || "",
    );
    const words = countWords(text);

    elements.inputWords.textContent = `${words} ${
      words === 1 ? "word" : "words"
    }`;
    elements.inputChars.textContent = `${text.length} ${
      text.length === 1 ? "character" : "characters"
    }`;
  }

  // Calculate output line/character totals from the editable output textarea.
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

  // Enable actions only when their prerequisite data exists and conversion is idle.
  function updateButtons() {
    const hasInput = Boolean(state.inputText.trim());
    const hasOutput = Boolean(elements.outputTextarea.value);
    const headingBase = state.outputHeadingBase || elements.outputTextarea.value;
    const headingLevels = getHeadingLevels(headingBase);
    const minimumHeadingOffset = headingLevels.length
      ? 1 - Math.max(...headingLevels)
      : 0;
    const maximumHeadingOffset = headingLevels.length
      ? 6 - Math.min(...headingLevels)
      : 0;

    elements.convertButton.disabled = !hasInput || isConverting;
    elements.copyButton.disabled = !hasOutput || isConverting;
    elements.increaseHeadingLevelButton.disabled =
      isConverting ||
      !headingLevels.length ||
      state.headingLevelOffset >= maximumHeadingOffset;
    elements.decreaseHeadingLevelButton.disabled =
      isConverting ||
      !headingLevels.length ||
      state.headingLevelOffset <= minimumHeadingOffset;
    elements.resetHeadingLevelButton.disabled =
      isConverting || !headingLevels.length || state.headingLevelOffset === 0;
    elements.clearInputButton.disabled =
      !hasInput && !elements.outputTextarea.value;
  }

  // Count whitespace-separated tokens; an empty string contains zero words.
  function countWords(value) {
    const matches = value.trim().match(/\S+/g);
    return matches ? matches.length : 0;
  }

  // Update a status message and replace, rather than accumulate, its semantic style.
  function setStatus(element, message, type = "") {
    element.textContent = message;
    element.className = `status-message ${type}`.trim();
  }

  // Format stored ISO dates for the UI, safely handling malformed historic data.
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

  // Add a transient accessible notification and schedule its own cleanup.
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

  // Provide cross-platform Ctrl/Cmd shortcuts without intercepting unmodified typing.
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

  // Wait two animation frames so the browser can render the conversion overlay first.
  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }

  initialise();
})();
