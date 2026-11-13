import { selectAll } from '@codemirror/commands';
import { bracketMatching, codeFolding, foldGutter, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

import { codeLanguageFor } from './codeViewerLanguages';

// Token colors come from CSS variables (document-viewers.css), so they follow the light and dark themes.
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--code-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--code-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--code-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--code-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.self], color: 'var(--code-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--code-property)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--code-tag)' },
  { tag: [t.heading], color: 'var(--code-keyword)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--code-string)', textDecoration: 'underline' },
  { tag: [t.inserted], color: 'var(--code-string)' },
  { tag: [t.deleted, t.invalid], color: 'var(--code-deleted)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--code-comment)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'transparent', color: 'var(--utility-foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.7', overflow: 'auto' },
  '.cm-content': { padding: '14px 0 28px', caretColor: 'transparent' },
  '.cm-line': { padding: '0 20px 0 6px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--utility-muted-text)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 16px', minWidth: '3ch', opacity: '0.6' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--utility-foreground)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', opacity: '0.55', cursor: 'pointer' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--code-selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--code-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--code-match)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--code-match-current)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--code-match)', outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--app-transcript-bg)', color: 'var(--utility-foreground)', borderColor: 'var(--app-control-border)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--app-control-border)' },
});

/**
 * Read-only source of an artifact: line numbers, syntax colors, Cmd-F search, folding, and
 * optional line wrapping. It fills its container; selecting and copying work as in an editor.
 */
export default function CodeViewer({ text, path, wrap }: { text: string; path: string; wrap: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapRef = useRef(new Compartment());
  // The latest wrap choice, read when a new view is built for new text.
  const wrapNow = useRef(wrap);
  useEffect(() => { wrapNow.current = wrap; });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const language = codeLanguageFor(path);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          drawSelection(),
          codeFolding(),
          foldGutter({ openText: '⌄', closedText: '›' }),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([...searchKeymap, { key: 'Mod-a', run: selectAll }]),
          syntaxHighlighting(highlightStyle),
          theme,
          wrapRef.current.of(wrapNow.current ? EditorView.lineWrapping : []),
          ...(language ? [language] : []),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [text, path]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapRef.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  return <div ref={hostRef} className="app-code-viewer" data-code-viewer="" />;
}
