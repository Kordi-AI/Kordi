import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codeLanguageFor } from '../src/features/documents/viewers/codeViewerLanguages';
import { parseDelimited } from '../src/features/documents/viewers/delimitedText';
import { companionViewerKind } from '../src/features/documents/viewers/viewerKind';

test('delimited text keeps quoted delimiters, quotes, and line breaks inside a field', () => {
  assert.deepEqual(parseDelimited('Plan,Note\nTeam,"Up to 25 seats, billed yearly"\nPro,"He said ""hi"""\n', ','), [
    ['Plan', 'Note'],
    ['Team', 'Up to 25 seats, billed yearly'],
    ['Pro', 'He said "hi"'],
  ]);
  assert.deepEqual(parseDelimited('a\tb\r\n1\t"two\nlines"\r\n\r\n', '\t'), [['a', 'b'], ['1', 'two\nlines']]);
  assert.deepEqual(parseDelimited('\n\n', ','), [], 'blank lines are not rows');
});

test('each file picks its viewer by type', () => {
  assert.equal(companionViewerKind('data/prices.csv'), 'table');
  assert.equal(companionViewerKind('data/prices.TSV'), 'table');
  assert.equal(companionViewerKind('brand/logo.svg'), 'svg');
  assert.equal(companionViewerKind('shots/hero.jpeg'), 'image');
  assert.equal(companionViewerKind('decks/pricing.PDF'), 'pdf');
  for (const path of ['plan.docx', 'model.xlsx', 'deck.key', 'deck.pptx', 'clip.mov', 'voice.m4a', 'bundle.zip']) {
    assert.equal(companionViewerKind(path), 'file', `${path} shows as a file card`);
  }
  assert.equal(companionViewerKind('src/app.ts'), 'code');
  assert.equal(companionViewerKind('notes/README'), 'code');
});

test('the code viewer has grammars for common languages and plain text for the rest', () => {
  for (const path of ['a.ts', 'a.tsx', 'a.js', 'a.py', 'a.json', 'a.rs', 'a.go', 'a.java', 'a.c', 'a.html', 'a.css', 'a.md', 'a.sql', 'a.yaml', 'a.xml', 'run.sh', 'a.swift', 'Cargo.toml', 'a.rb', 'fix.diff', 'Dockerfile', '.env']) {
    assert.ok(codeLanguageFor(path), `a grammar for ${path}`);
  }
  assert.equal(codeLanguageFor('notes.txt'), null);
  assert.equal(codeLanguageFor('LICENSE'), null);
});
