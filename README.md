# WikiConvert

Vibe coded with GPT 5.6 Sol.

Live demo: <https://andygock.github.io/wiki-convert/>

WikiConvert turns rich text copied from Microsoft Word, LibreOffice, websites, email clients, and other applications into clean MediaWiki markup. Conversion happens entirely in the browser, so pasted content is never sent to a server.

## Features

- Converts headings, paragraphs, bold, italic, underline, strikethrough, and inline code
- Handles ordered, unordered, and nested lists, including Microsoft Word list metadata
- Converts tables, links, block quotes, preformatted text, horizontal rules, superscript, subscript, and explicit line breaks
- Provides optional automatic conversion and configurable table markup
- Accepts pasted or dropped rich text, plus dropped `.txt`, `.html`, and `.rtf` files
- Lets you shift every generated heading up or down a level
- Includes copy-to-clipboard support and keyboard shortcuts
- Uses Jodit, Word Cleaner, and Turndown from pinned CDN releases; requires no
  build tools, package manager, backend, or conversion service

## Getting started

Clone or download the repository, then serve the directory with any static file
server. For example, if Python is installed:

```sh
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Usage

1. Copy formatted content from a rich-text application.
2. Paste or drop it into the **Rich text input** panel.
3. Select **Convert**, or leave automatic conversion enabled.
4. Review or edit the generated MediaWiki markup. Use **+1**, **−1**, or
   **Reset** to adjust all heading levels if needed.
5. Select **Copy**.

Keyboard shortcuts:

| Action          | Windows/Linux      | macOS                 |
| --------------- | ------------------ | --------------------- |
| Convert content | `Ctrl + Enter`     | `Command + Enter`     |
| Copy output     | `Ctrl + Shift + C` | `Command + Shift + C` |
| Focus input     | `Ctrl + Shift + V` | `Command + Shift + V` |

## Privacy and storage

All conversion runs locally in the browser. WikiConvert does not upload pasted
content or use a third-party conversion service. The CDN is used only to
download the application libraries; pasted content is never sent to it.

Input, output, and settings are held in memory for the current tab only. They
are discarded when the page is reloaded or the tab is closed.

## Project structure

```text
index.html               Application structure and interface
css/
  main.css               Stylesheet entry point
  base.css               Theme, shell, navigation, and modal styles
  converter.css          Converter panels, editor, and output styles
  components.css         Settings, notifications, and shared components
  responsive.css         Responsive and reduced-motion rules
js/
  app.js                 Application state and browser interactions
  converter.js           Turndown MediaWiki rules and HTML sanitisation
```

## License

WikiConvert is open-source software licensed under the [MIT License](LICENSE).
