import {
  convertHtmlToMediaWiki,
  escapeHtml,
  normalisePlainText,
  sanitiseInputHtml,
  stripRtfControlWords,
} from "./converter.js";

(() => {
  "use strict";

  // Debounce typing so auto-convert runs only after the user pauses briefly.
  const AUTO_CONVERT_DELAY_MS = 450;

  // This is both the first-run state and the schema fallback for older/corrupt
  // saved data. Keep every user-persisted field represented here.
  const defaultState = {
    inputHtml: "",
    inputText: "",
    output: "",
    outputHeadingBase: "",
    headingLevelOffset: 0,
    settings: {
      autoConvert: true,
      preserveLineBreaks: false,
      externalLinks: true,
      tableClass: "wikitable",
    },
  };

  // Cache every DOM dependency once. The rest of the script refers to this map
  // instead of repeatedly querying the document.
  const elements = {
    settingsModal: document.querySelector("#settings-modal"),
    aboutModal: document.querySelector("#about-modal"),
    openSettingsButton: document.querySelector("#open-settings-button"),
    openAboutButton: document.querySelector("#open-about-button"),

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

    settingAutoConvert: document.querySelector("#setting-auto-convert"),
    settingPreserveLineBreaks: document.querySelector(
      "#setting-preserve-line-breaks",
    ),
    settingExternalLinks: document.querySelector("#setting-external-links"),
    settingTableClass: document.querySelector("#setting-table-class"),
    toastRegion: document.querySelector("#toast-region"),
  };

  // Runtime-only flags are not stored: a page reload must never resume an
  // in-progress conversion or a stale debounce timer.
  let state = structuredClone(defaultState);
  let autoConvertTimer = null;
  let isConverting = false;
  let quill = null;

  // Apply an in-memory state update. Nothing is persisted between page loads.
  function setState(updates) {
    state = {
      ...state,
      ...updates,
    };
  }

  // Restore UI from state, calculate derived UI, then attach event handlers.
  function initialise() {
    initialiseQuill();
    hydrateSettings();
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

  // Copy session settings into the settings form controls.
  function hydrateSettings() {
    elements.settingAutoConvert.checked = state.settings.autoConvert;
    elements.settingPreserveLineBreaks.checked =
      state.settings.preserveLineBreaks;
    elements.settingExternalLinks.checked = state.settings.externalLinks;
    elements.settingTableClass.value = state.settings.tableClass;
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

  // Register editor, modal, clipboard, settings, and shortcut handlers.
  function bindEvents() {
    elements.openSettingsButton.addEventListener("click", () => {
      elements.settingsModal.showModal();
    });
    elements.openAboutButton.addEventListener("click", () => {
      elements.aboutModal.showModal();
    });
    document.querySelectorAll(".modal-close").forEach((button) => {
      button.addEventListener("click", () => button.closest("dialog").close());
    });
    [elements.settingsModal, elements.aboutModal].forEach((modal) => {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) {
          modal.close();
        }
      });
    });

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

    elements.settingAutoConvert.addEventListener("change", updateSettings);
    elements.settingPreserveLineBreaks.addEventListener(
      "change",
      updateSettings,
    );
    elements.settingExternalLinks.addEventListener("change", updateSettings);
    elements.settingTableClass.addEventListener("change", updateSettings);
    document.addEventListener("keydown", handleKeyboardShortcuts);
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

      const output = convertHtmlToMediaWiki(sourceHtml, state.settings);

      elements.outputTextarea.value = output;

      setState({
        output,
        outputHeadingBase: output,
        headingLevelOffset: 0,
      });

      updateOutputStats();

      if (output) {
        setStatus(elements.outputStatus, "Conversion complete", "success");
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
    };

    setState({
      settings,
    });

    if (state.inputText.trim() && settings.autoConvert) {
      scheduleAutoConvert();
    }

    showToast("Settings updated for this session.", "success");
  }

  // Return the in-memory UI to defaults.
  function resetApplication() {
    state = structuredClone(defaultState);

    clearTimeout(autoConvertTimer);

    quill.setText("", "silent");
    elements.editorContainer.classList.add("hidden");
    elements.dropInstructions.classList.remove("hidden");
    elements.outputTextarea.value = "";

    hydrateSettings();
    updateInputStats();
    updateOutputStats();
    updateButtons();
    setStatus(elements.inputStatus, "Waiting for input");
    setStatus(elements.outputStatus, "No conversion yet");

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
