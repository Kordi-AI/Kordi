import { cppLanguage } from '@codemirror/lang-cpp';
import { cssLanguage } from '@codemirror/lang-css';
import { goLanguage } from '@codemirror/lang-go';
import { htmlLanguage } from '@codemirror/lang-html';
import { javaLanguage } from '@codemirror/lang-java';
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from '@codemirror/lang-javascript';
import { jsonLanguage } from '@codemirror/lang-json';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { pythonLanguage } from '@codemirror/lang-python';
import { rustLanguage } from '@codemirror/lang-rust';
import { StandardSQL } from '@codemirror/lang-sql';
import { xmlLanguage } from '@codemirror/lang-xml';
import { yamlLanguage } from '@codemirror/lang-yaml';
import { StreamLanguage, type Language, type StreamParser } from '@codemirror/language';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import type { Extension } from '@codemirror/state';

const stream = <State>(parser: StreamParser<State>) => StreamLanguage.define(parser);

// Grammars by file extension, as bare languages: a read-only viewer needs colors and folding, not
// the completion and lint support the full language packages add. Anything else is plain text.
const LANGUAGES: Record<string, () => Language> = {
  js: () => javascriptLanguage, mjs: () => javascriptLanguage, cjs: () => javascriptLanguage,
  jsx: () => jsxLanguage,
  ts: () => typescriptLanguage, mts: () => typescriptLanguage, cts: () => typescriptLanguage,
  tsx: () => tsxLanguage,
  json: () => jsonLanguage, jsonc: () => jsonLanguage,
  py: () => pythonLanguage, pyi: () => pythonLanguage,
  rs: () => rustLanguage,
  go: () => goLanguage,
  java: () => javaLanguage, kt: () => javaLanguage,
  c: () => cppLanguage, h: () => cppLanguage, cc: () => cppLanguage, cpp: () => cppLanguage, hpp: () => cppLanguage, m: () => cppLanguage, mm: () => cppLanguage,
  html: () => htmlLanguage, htm: () => htmlLanguage, vue: () => htmlLanguage, svelte: () => htmlLanguage,
  css: () => cssLanguage, scss: () => cssLanguage, less: () => cssLanguage,
  md: () => markdownLanguage, markdown: () => markdownLanguage, mdx: () => markdownLanguage,
  sql: () => StandardSQL.language,
  yaml: () => yamlLanguage, yml: () => yamlLanguage,
  xml: () => xmlLanguage, svg: () => xmlLanguage, plist: () => xmlLanguage,
  sh: () => stream(shell), bash: () => stream(shell), zsh: () => stream(shell),
  swift: () => stream(swift),
  toml: () => stream(toml),
  rb: () => stream(ruby),
  diff: () => stream(diff), patch: () => stream(diff),
  dockerfile: () => stream(dockerFile),
  properties: () => stream(properties), ini: () => stream(properties), env: () => stream(properties),
};

/** The grammar for a file, by its extension or a well-known name such as Dockerfile. */
export function codeLanguageFor(path: string): Extension | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const extension = name === 'dockerfile' ? 'dockerfile' : name.includes('.') ? name.split('.').pop() ?? '' : '';
  const language = LANGUAGES[extension];
  return language ? language() : null;
}
