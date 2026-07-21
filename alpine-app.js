(() => {
  "use strict";

  // This component owns browser-facing state and interaction only. Rich-text
  // parsing and MediaWiki generation remain isolated in script.js.
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
    converter: ["MediaWiki Converter", "Paste or drop formatted content and convert it locally"],
    history: ["Conversion History", "Review and reuse recent browser-local conversions"],
    settings: ["Settings", "Configure conversion behaviour and local storage"],
    about: ["About WikiConvert", "Supported markup, privacy, shortcuts, and limitations"],
  };

  document.addEventListener("alpine:init", () => {
    Alpine.data("wikiConvert", () => ({
      ...structuredClone(defaultState),
      mobileMenuOpen: false,
      inputVisible: false,
      dragActive: false,
      isConverting: false,
      inputStatus: { message: "Waiting for input", type: "" },
      outputStatus: { message: "No conversion yet", type: "" },
      storageStatus: "State saved locally",
      toasts: [],
      autoConvertTimer: null,

      // Alpine calls init() automatically. Restore the serialisable state first,
      // then hydrate the contenteditable element once its x-ref is available.
      init() {
        Object.assign(this, this.loadState());
        if (!pageMetadata[this.currentView]) this.currentView = "converter";
        this.inputVisible = Boolean(this.inputHtml || this.inputText);
        this.$nextTick(() => {
          if (this.inputHtml) {
            this.$refs.richInput.innerHTML = WikiConverter.sanitiseInputHtml(this.inputHtml);
          } else if (this.inputText) {
            this.$refs.richInput.textContent = this.inputText;
          }
          if (this.output) this.setOutputStatus("Saved output restored", "success");
        });
      },

      loadState() {
        try {
          const saved = localStorage.getItem(STORAGE_KEY);
          if (!saved) return structuredClone(defaultState);
          const parsed = JSON.parse(saved);
          return {
            ...structuredClone(defaultState),
            ...parsed,
            settings: { ...defaultState.settings, ...(parsed.settings ?? {}) },
            history: Array.isArray(parsed.history) ? parsed.history : [],
          };
        } catch {
          return structuredClone(defaultState);
        }
      },

      persist() {
        // Persist an explicit allow-list so transient UI flags and timer handles
        // never leak into localStorage.
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            currentView: this.currentView,
            inputHtml: this.inputHtml,
            inputText: this.inputText,
            output: this.output,
            history: this.history,
            settings: this.settings,
          }));
          this.storageStatus = "State saved locally";
        } catch {
          this.storageStatus = "Local storage unavailable";
        }
      },

      get pageTitle() { return pageMetadata[this.currentView][0]; },
      get pageSubtitle() { return pageMetadata[this.currentView][1]; },
      get inputWords() { return this.inputText.trim().match(/\S+/g)?.length ?? 0; },
      get outputLines() { return this.output ? this.output.split("\n").length : 0; },
      plural(count, singular, plural = `${singular}s`) {
        return `${count} ${count === 1 ? singular : plural}`;
      },

      switchView(view) {
        this.currentView = pageMetadata[view] ? view : "converter";
        this.mobileMenuOpen = false;
        this.persist();
      },
      closeMobileMenuOnDesktop() {
        if (window.innerWidth > 820) this.mobileMenuOpen = false;
      },
      showAndFocusInput() {
        this.inputVisible = true;
        this.$nextTick(() => this.$refs.richInput.focus());
      },

      // contenteditable cannot use x-model reliably for rich HTML, so mirror its
      // HTML and normalised text into Alpine state from the input event.
      handleRichInput() {
        this.inputHtml = this.$refs.richInput.innerHTML;
        this.inputText = WikiConverter.normalisePlainText(this.$refs.richInput.innerText);
        this.inputVisible = true;
        this.inputStatus = this.inputText
          ? { message: "Input updated", type: "success" }
          : { message: "Waiting for input", type: "" };
        this.persist();
        this.scheduleAutoConvert();
      },

      handlePaste(event) {
        const clipboard = event.clipboardData;
        if (!clipboard) return;
        const html = clipboard.getData("text/html");
        if (!html) return;
        event.preventDefault();
        const cleaned = WikiConverter.sanitiseInputHtml(html);
        this.insertHtmlAtSelection(cleaned || WikiConverter.escapeHtml(clipboard.getData("text/plain")));
        this.handleRichInput();
      },

      // Drop events may contain clipboard-style HTML/text or a supported file.
      // Both paths converge on applyInputContent() to keep sanitisation uniform.
      handleDrag(event, active) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "dragleave" && event.currentTarget.contains(event.relatedTarget)) return;
        if (active && event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        this.dragActive = active;
      },

      async handleDrop(event) {
        this.handleDrag(event, false);
        const transfer = event.dataTransfer;
        if (!transfer) return;
        const html = transfer.getData("text/html");
        const text = transfer.getData("text/plain");
        if (html || text) return this.applyInputContent({ html, text });
        const file = [...transfer.files][0];
        if (!file) return this.showToast("No supported content was found in the dropped data.", "warning");
        if (!["text/plain", "text/html", "text/rtf", "application/rtf"].includes(file.type)
          && !/\.(txt|html?|rtf)$/i.test(file.name)) {
          return this.showToast("Drop text, HTML, RTF text, or copied rich text.", "warning");
        }
        try {
          const fileText = await file.text();
          this.applyInputContent(
            /\.html?$/i.test(file.name) || file.type === "text/html"
              ? { html: fileText }
              : { text: WikiConverter.stripRtfControlWords(fileText) },
          );
        } catch {
          this.showToast("The dropped file could not be read.", "error");
        }
      },

      async pasteFromClipboard() {
        if (!navigator.clipboard) {
          this.showAndFocusInput();
          return this.showToast("Use Ctrl+V because direct clipboard access is unavailable.", "warning");
        }
        try {
          if (navigator.clipboard.read) {
            const items = await navigator.clipboard.read();
            let html = "";
            let text = "";
            for (const item of items) {
              if (item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
              if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
              if (html || text) break;
            }
            if (!html && !text) throw new Error("Clipboard did not contain text");
            this.applyInputContent({ html, text });
          } else {
            const text = await navigator.clipboard.readText();
            if (!text) throw new Error("Clipboard did not contain text");
            this.applyInputContent({ text });
          }
        } catch {
          this.showAndFocusInput();
          this.showToast("Clipboard permission was not granted. Press Ctrl+V inside the input area.", "warning");
        }
      },

      applyInputContent({ html = "", text = "" }) {
        this.inputVisible = true;
        this.$nextTick(() => {
          if (html) this.$refs.richInput.innerHTML = WikiConverter.sanitiseInputHtml(html);
          else this.$refs.richInput.textContent = text;
          this.handleRichInput();
          this.$refs.richInput.focus();
        });
      },

      // Insert sanitized rich HTML at the current caret without replacing the
      // user's existing editor contents.
      insertHtmlAtSelection(html) {
        const input = this.$refs.richInput;
        const selection = window.getSelection();
        if (!selection?.rangeCount || !input.contains(selection.getRangeAt(0).commonAncestorContainer)) {
          input.insertAdjacentHTML("beforeend", html);
          return;
        }
        const range = selection.getRangeAt(0);
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
      },

      clearInput() {
        clearTimeout(this.autoConvertTimer);
        this.$refs.richInput.innerHTML = "";
        Object.assign(this, {
          inputVisible: false,
          inputHtml: "",
          inputText: "",
          output: "",
          inputStatus: { message: "Waiting for input", type: "" },
          outputStatus: { message: "No conversion yet", type: "" },
        });
        this.persist();
        this.showToast("Input and output cleared.");
      },

      scheduleAutoConvert() {
        clearTimeout(this.autoConvertTimer);
        if (!this.settings.autoConvert || !this.inputText.trim()) return;
        this.autoConvertTimer = window.setTimeout(() => this.convertContent(), AUTO_CONVERT_DELAY_MS);
      },

      // Yield two animation frames so Alpine can paint the busy overlay before
      // the synchronous DOM conversion starts.
      async convertContent() {
        if (this.isConverting || !this.inputText.trim()) return;
        this.isConverting = true;
        this.setOutputStatus("Converting content");
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        try {
          const source = this.inputHtml || `<p>${WikiConverter.escapeHtml(this.inputText)}</p>`;
          this.output = WikiConverter.convert(source, this.settings);
          this.persist();
          if (this.output) {
            this.setOutputStatus("Conversion complete", "success");
            this.saveHistoryEntry();
          } else {
            this.setOutputStatus("No convertible content was found", "warning");
          }
        } catch (error) {
          console.error(error);
          this.setOutputStatus("Conversion failed", "error");
          this.showToast("The content could not be converted. Try plain text.", "error");
        } finally {
          this.isConverting = false;
        }
      },

      handleOutputChange() {
        this.setOutputStatus("Output edited", "success");
        this.persist();
      },
      async copyText(text, history = false) {
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          if (!history) this.setOutputStatus("Copied to clipboard", "success");
          this.showToast(history ? "History output copied to the clipboard." : "MediaWiki markup copied to the clipboard.", "success");
        } catch {
          if (!history && this.$refs.output) {
            this.$refs.output.focus();
            this.$refs.output.select();
            if (document.execCommand("copy")) {
              this.setOutputStatus("Copied to clipboard", "success");
              this.showToast("MediaWiki markup copied to the clipboard.", "success");
              return;
            }
            this.setOutputStatus("Select and copy manually", "warning");
          }
          this.showToast("Clipboard access is unavailable.", "error");
        }
      },

      saveHistoryEntry() {
        // Avoid consecutive duplicates and enforce the configured limit at the
        // point of insertion, keeping persisted state bounded.
        if (!this.settings.saveHistory || !this.output.trim() || this.history[0]?.output === this.output) return;
        this.history = [{
          id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          createdAt: new Date().toISOString(),
          title: this.deriveHistoryTitle(this.output),
          inputHtml: this.inputHtml,
          inputText: this.inputText,
          output: this.output,
        }, ...this.history].slice(0, this.settings.historyLimit);
        this.persist();
      },
      deriveHistoryTitle(output) {
        const line = output.split("\n").map((value) => value
          .replace(/^={1,6}\s*|\s*={1,6}$/g, "")
          .replace(/^[*#:;]+\s*/, "").replace(/'{2,3}/g, "")
          .replace(/<[^>]+>/g, "").trim()).find(Boolean) || "Untitled conversion";
        return line.length > 70 ? `${line.slice(0, 67)}...` : line;
      },
      restoreHistory(entry) {
        Object.assign(this, {
          inputHtml: entry.inputHtml || "",
          inputText: entry.inputText || "",
          output: entry.output,
          inputVisible: true,
        });
        this.switchView("converter");
        this.$nextTick(() => {
          if (this.inputHtml) this.$refs.richInput.innerHTML = WikiConverter.sanitiseInputHtml(this.inputHtml);
          else this.$refs.richInput.textContent = this.inputText;
        });
        this.showToast("Conversion restored.", "success");
      },
      deleteHistory(id) {
        this.history = this.history.filter((entry) => entry.id !== id);
        this.persist();
        this.showToast("History entry deleted.");
      },
      clearHistory() {
        if (!this.history.length) return;
        this.history = [];
        this.persist();
        this.showToast("Conversion history cleared.");
      },
      formatDateTime(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat("en-AU", {
          dateStyle: "medium", timeStyle: "short",
        }).format(date);
      },

      updateSettings() {
        // Select values arrive as strings; normalise the limit before slicing or
        // persisting history.
        this.settings.historyLimit = Number(this.settings.historyLimit);
        this.history = this.history.slice(0, this.settings.historyLimit);
        this.persist();
        if (this.inputText.trim() && this.settings.autoConvert) this.scheduleAutoConvert();
        this.showToast("Settings saved locally.", "success");
      },
      resetApplication() {
        localStorage.removeItem(STORAGE_KEY);
        clearTimeout(this.autoConvertTimer);
        Object.assign(this, structuredClone(defaultState), {
          inputVisible: false,
          mobileMenuOpen: false,
          inputStatus: { message: "Waiting for input", type: "" },
          outputStatus: { message: "No conversion yet", type: "" },
        });
        this.$refs.richInput.innerHTML = "";
        this.persist();
        this.showToast("Application data reset.");
      },
      setOutputStatus(message, type = "") { this.outputStatus = { message, type }; },
      showToast(message, type = "info", duration = 3200) {
        const id = `${Date.now()}-${Math.random()}`;
        this.toasts.push({ id, message, type });
        window.setTimeout(() => {
          this.toasts = this.toasts.filter((toast) => toast.id !== id);
        }, duration);
      },
      handleKeyboardShortcut(event) {
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          this.convertContent();
        } else if (event.shiftKey && event.key.toLowerCase() === "c") {
          event.preventDefault();
          this.copyText(this.output);
        } else if (event.shiftKey && event.key.toLowerCase() === "v") {
          event.preventDefault();
          this.switchView("converter");
          this.showAndFocusInput();
        }
      },
    }));
  });
})();
