import { useEffect, useRef } from "react";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { ChangeSet, EditorState, Transaction } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { tags } from "@lezer/highlight";
import { attachBuffer, saveFile, useCode } from "./code";
import type { CodeFile } from "./code";

function language(path: string): Extension {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "css") return css();
  if (["ts", "tsx"].includes(extension))
    return javascript({ typescript: true, jsx: extension === "tsx" });
  if (["js", "mjs", "cjs", "jsx", "json"].includes(extension))
    return javascript({ jsx: extension === "jsx" });
  return html();
}

const theme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "var(--text-primary)",
      backgroundColor: "var(--surface-panel)",
      fontSize: "var(--type-md)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      fontStretch: "var(--stretch-mono)",
      lineHeight: "var(--leading-body)",
    },
    ".cm-content": { caretColor: "var(--caret)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--caret)" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "var(--text-selection-bg)" },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "var(--overlay-hover)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--surface-panel)",
      color: "var(--text-quiet)",
      border: "none",
    },
    ".cm-activeLineGutter": { color: "var(--text-secondary)" },
    ".cm-selectionMatch, .cm-searchMatch": {
      backgroundColor: "transparent",
      outline: "var(--stroke-hair) solid var(--line-strong)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      outline: "var(--stroke-hair) solid var(--selection)",
    },
    "&.cm-focused .cm-matchingBracket": {
      backgroundColor: "var(--surface-active)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--text-secondary)",
    },
    ".cm-panels": {
      backgroundColor: "var(--surface-raised)",
      color: "var(--text-primary)",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "var(--stroke-hair) solid var(--line)",
    },
    ".cm-textfield": {
      backgroundColor: "var(--surface-panel)",
      color: "var(--text-primary)",
      border: "var(--stroke-hair) solid var(--line)",
      borderRadius: "var(--radius-control)",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--surface-active)",
      color: "var(--text-primary)",
      border: "none",
      borderRadius: "var(--radius-control)",
    },
    ".cm-specialChar": { color: "var(--danger)" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.self],
    color: "var(--code-keyword)",
  },
  {
    tag: [tags.tagName, tags.typeName, tags.className, tags.namespace],
    color: "var(--code-name)",
  },
  {
    tag: [tags.attributeName, tags.propertyName],
    color: "var(--code-attribute)",
  },
  {
    tag: [
      tags.string,
      tags.attributeValue,
      tags.special(tags.string),
      tags.regexp,
      tags.url,
    ],
    color: "var(--code-string)",
  },
  {
    tag: [
      tags.number,
      tags.unit,
      tags.bool,
      tags.atom,
      tags.color,
      tags.constant(tags.name),
    ],
    color: "var(--code-number)",
  },
  { tag: [tags.comment, tags.meta], color: "var(--text-tertiary)" },
  {
    tag: [tags.punctuation, tags.angleBracket, tags.operator],
    color: "var(--text-secondary)",
  },
  { tag: tags.invalid, color: "var(--danger)" },
]);

const extensions = (path: string, separator: string): Extension[] => [
  lineNumbers(),
  foldGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  highlightSelectionMatches(),
  // The panel is narrower than most authored lines; wrapping keeps each one readable in place.
  EditorView.lineWrapping,
  keymap.of([
    { key: "Mod-s", run: () => (void saveFile(), true) },
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
  ]),
  // Lines split only where the file breaks them, so a save writes back exactly what was read.
  EditorState.lineSeparator.of(separator),
  language(path),
  theme,
  syntaxHighlighting(highlight),
  EditorView.contentAttributes.of({ "aria-label": `Source of ${path}` }),
  EditorView.updateListener.of((update) => {
    if (update.docChanged) track();
  }),
];

/** The one replacement that turns `from` into `to`: their common start and end stay put. */
function difference(from: string, to: string) {
  let start = 0;
  const shortest = Math.min(from.length, to.length);
  while (start < shortest && from[start] === to[start]) start++;
  let end = 0;
  while (
    end < shortest - start &&
    from[from.length - 1 - end] === to[to.length - 1 - end]
  )
    end++;
  return {
    from: start,
    to: from.length - end,
    insert: to.slice(start, to.length - end),
  };
}

let view: EditorView | null = null;
/** The file text the buffer is compared with, and the file it came from. */
let base: { file: CodeFile; doc: Text } | null = null;

function track() {
  if (!view || !base) return;
  const edited = !view.state.doc.eq(base.doc);
  if (useCode.getState().edited !== edited) useCode.setState({ edited });
}

function take(file: CodeFile | null) {
  if (!view) return;
  const separator = file?.content.includes("\r\n") ? "\r\n" : "\n";
  if (!file) {
    base = null;
    view.setState(EditorState.create());
  } else if (
    !base ||
    base.file.path !== file.path ||
    view.state.lineBreak !== separator
  ) {
    view.setState(
      EditorState.create({
        doc: file.content,
        extensions: extensions(file.path, separator),
      }),
    );
  } else if (base.file.load !== file.load) {
    // A file reloaded under the same name keeps the cursor and scroll outside what changed.
    // Lines count as one position each, so compare the documents with single breaks. Undo in
    // the buffer takes back the person's typing, not the outside change.
    const doc = view.state.toText(file.content);
    base = { file, doc };
    view.dispatch({
      changes: difference(view.state.doc.toString(), doc.toString()),
      annotations: Transaction.addToHistory.of(false),
    });
  }
  base = file && { file, doc: view.state.toText(file.content) };
  track();
}

/** Selects the start of `offset` in the file's text, following edits made since it was read. */
function reveal(target: { offset: number; version: string } | null) {
  if (!view || !base || !target || target.version !== base.file.version) return;
  const { content } = base.file;
  // Server offsets count a CRLF break as two characters; the document counts every break once.
  const breaks =
    view.state.lineBreak === "\r\n"
      ? content.slice(0, target.offset).split("\r\n").length - 1
      : 0;
  const position = ChangeSet.of(
    difference(base.doc.toString(), view.state.doc.toString()),
    base.doc.length,
  ).mapPos(Math.min(target.offset - breaks, base.doc.length));
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "center" }),
  });
}

/** The code panel's CodeMirror editor, loaded on first use. */
export default function CodeEditor() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current });
    view = editor;
    const detach = attachBuffer(() => editor.state.sliceDoc());
    const state = useCode.getState();
    take(state.file);
    reveal(state.reveal);
    const stop = useCode.subscribe((next, previous) => {
      if (next.file !== previous.file) take(next.file);
      if (next.reveal !== previous.reveal) reveal(next.reveal);
    });
    return () => {
      stop();
      detach();
      editor.destroy();
      view = null;
      base = null;
    };
  }, []);
  return <div ref={host} className="code-editor" />;
}
