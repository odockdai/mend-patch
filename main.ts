// mend: one CLI that applies AI-written edits (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON
// text-editor calls) to a tree of text files, every change or none, as SPEC.md specifies.
// Node 22 and its standard library alone: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set; the last lines hand over to the kit's
// runner.ts, which runs this file once per check.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: usage, no-patch, format or parse. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const parseError = (zeroBased: number): Exit2 => new Exit2(`error: parse ${zeroBased + 1}`);
const isBlank = (s: string): boolean => s.trim() === '';
/** Unified and V4A paths and anchors drop surrounding spaces only; SEARCH/REPLACE paths drop all whitespace. */
const stripSpaces = (s: string): string => s.replace(/^ +| +$/g, '');

/** SPEC 3: a patch's lines, each without one trailing CR, without the empty piece after a final LF. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC 3: not empty, not absolute, no backslash, no empty, `.` or `..` segment. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------------------------------------------------------------------------------------------------------------
// Files as lines (SPEC 3)

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function readDoc(text: string): Doc {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** A file an edit creates: LF breaks, a final break unless the format says otherwise. */
function createdText(lines: string[], final: boolean): string {
  return writeDoc({ lines, br: '\n', final });
}

// ---------------------------------------------------------------------------------------------------------------
// Matching lines at three tiers (SPEC 5)

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const dropTrailing = (s: string): string => s.replace(/[ \t]+$/, '');

function atTier(s: string, tier: number): string {
  if (tier === 0) return s;
  const r = dropTrailing(s);
  return tier === 1 ? r : r.slice(leadingWs(r).length);
}

function tiersFor(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function matchesAt(lines: string[], old: string[], at: number, tier: number): boolean {
  if (at < 0 || at + old.length > lines.length) return false;
  for (let j = 0; j < old.length; j++) {
    if (atTier(lines[at + j]!, tier) !== atTier(old[j]!, tier)) return false;
  }
  return true;
}

/** Every position of `old` at the first tier with at least one, or null when no tier has one. */
function findAll(lines: string[], old: string[], strict: boolean): { tier: number; at: number[] } | null {
  for (const tier of tiersFor(strict)) {
    const at: number[] = [];
    for (let i = 0; i + old.length <= lines.length; i++) if (matchesAt(lines, old, i, tier)) at.push(i);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** A body line of a hunk, block or chunk: context (in O and N), old (O only) or new (N only). */
interface Row {
  op: ' ' | '-' | '+';
  text: string;
  /** A `\` line follows it (unified diffs only). */
  noEol: boolean;
}

const oldOf = (rows: Row[]): string[] => rows.filter((r) => r.op !== '+').map((r) => r.text);
const newCount = (rows: Row[]): number => rows.filter((r) => r.op !== '-').length;

/**
 * Replaces the O of `rows`, matched at `at` (tier `tier`), with their N: context lines are the file's own matched
 * lines, and at tier 2 every other new line has O's first indentation swapped for the file's. Returns the number
 * of lines written.
 */
function replaceAt(lines: string[], rows: Row[], at: number, tier: number): number {
  const old = oldOf(rows);
  const fileIndent = old.length > 0 ? leadingWs(lines[at]!) : '';
  const patchIndent = old.length > 0 ? leadingWs(old[0]!) : '';
  const out: string[] = [];
  let j = 0;
  for (const r of rows) {
    if (r.op === ' ') out.push(lines[at + j++]!);
    else if (r.op === '-') j++;
    else if (tier === 2 && !isBlank(r.text) && r.text.startsWith(patchIndent)) out.push(fileIndent + r.text.slice(patchIndent.length));
    else out.push(r.text);
  }
  lines.splice(at, old.length, ...out);
  return out.length;
}

// ---------------------------------------------------------------------------------------------------------------
// The tree as the edits leave it (SPEC 10)

class Tree {
  private readonly before = new Map<string, string | null>();
  readonly after = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.before.has(p)) {
      let text: string | null = null;
      try {
        if (statSync(p).isFile()) text = readFileSync(p, 'utf8');
      } catch {
        text = null;
      }
      this.before.set(p, text);
    }
    return this.before.get(p)!;
  }

  get(p: string): string | null {
    return this.after.has(p) ? this.after.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.after.set(p, text);
  }
}

type Edit = (tree: Tree) => void;

function needSafe(...paths: string[]): void {
  for (const p of paths) if (!isSafe(p)) throw new Fail('unsafe', p);
}

function needFile(tree: Tree, p: string): string {
  const text = tree.get(p);
  if (text === null) throw new Fail('missing', p);
  return text;
}

function needNoFile(tree: Tree, p: string): void {
  if (tree.get(p) !== null) throw new Fail('exists', p);
}

function moveFile(tree: Tree, from: string, to: string, text: string): void {
  tree.set(to, text);
  tree.set(from, null);
  tree.moves.push([from, to]);
}

// ---------------------------------------------------------------------------------------------------------------
// Detecting the format (SPEC 4)

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (SPEC 6)

interface Hunk {
  start: number;
  rows: Row[];
}

interface Section {
  fromGit: boolean;
  gitOld: string | null;
  gitNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function newSection(fromGit: boolean, gitOld: string | null, gitNew: string | null): Section {
  return { fromGit, gitOld, gitNew, hasPair: false, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, creation: false, deletion: false, hunks: [] };
}

/** `diff --git a/<X> b/<Y>`; when several splits are possible, the one with X equal to Y, else the first. */
function gitHeaderPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const splits: number[] = [];
  for (let k = rest.indexOf(' b/', 2); k >= 0; k = rest.indexOf(' b/', k + 1)) splits.push(k);
  const usable = splits.filter((s) => s > 2 && s + 3 < rest.length);
  if (usable.length === 0) return null;
  const k = usable.find((s) => rest.slice(2, s) === rest.slice(s + 3)) ?? usable[0]!;
  return [rest.slice(2, k), rest.slice(k + 3)];
}

/** The path of a `--- ` or `+++ ` line: up to the first tab, trimmed, `/dev/null` as none, one `a/` or `b/` off. */
function pairPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = stripSpaces(p);
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function readUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const pairStarts = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const paths = gitHeaderPaths(line);
      if (paths === null) throw parseError(i);
      cur = newSection(true, paths[0], paths[1]);
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (pairStarts(i)) {
      if (cur === null || !inHeader || !cur.fromGit || cur.hasPair) {
        cur = newSection(false, null, null);
        sections.push(cur);
        inHeader = true;
      }
      cur.hasPair = true;
      cur.pairOld = pairPath(line);
      cur.pairNew = pairPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEADER.exec(line);
      if (m === null || cur === null) throw parseError(i);
      inHeader = false;
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || pairStarts(j)) break;
        if (b !== '' && !' -+\\'.includes(b[0]!)) break;
        body.push(b);
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const rows: Row[] = [];
      for (const b of body) {
        if (b.startsWith('\\')) {
          if (rows.length > 0) rows[rows.length - 1]!.noEol = true;
        } else if (b === '') rows.push({ op: ' ', text: '', noEol: false });
        else rows.push({ op: b[0] as Row['op'], text: b.slice(1), noEol: false });
      }
      cur.hunks.push({ start: Number(m[1]), rows });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw parseError(i + 1);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.creation = true;
      else if (line.startsWith('deleted file mode')) cur.deletion = true;
    }
    i += 1;
  }
  return sections;
}

function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): void {
  let drift = 0;
  for (const h of hunks) {
    const old = oldOf(h.rows);
    let at: number;
    let tier = 0;
    if (old.length > 0) {
      const found = findAll(doc.lines, old, strict);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      const want = h.start - 1 + drift;
      at = found.at[0]!;
      for (const p of found.at) if (Math.abs(p - want) < Math.abs(at - want)) at = p;
    } else {
      at = Math.min(Math.max(h.start + drift, 0), doc.lines.length);
    }
    const toEnd = at + old.length === doc.lines.length;
    replaceAt(doc.lines, h.rows, at, tier);
    if (toEnd) {
      const lastNew = [...h.rows].reverse().find((r) => r.op !== '-');
      doc.final = !(lastNew !== undefined && lastNew.noEol);
    }
    drift += newCount(h.rows) - old.length;
  }
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.hasPair ? s.pairOld : (s.renameFrom ?? s.gitOld);
  const newPath = s.hasPair ? s.pairNew : (s.renameTo ?? s.gitNew);
  if (oldPath === null || s.creation) {
    const p = newPath ?? oldPath ?? '';
    return (tree) => {
      needSafe(p);
      needNoFile(tree, p);
      const added = s.hunks.flatMap((h) => h.rows.filter((r) => r.op === '+'));
      const last = added[added.length - 1];
      tree.set(p, createdText(added.map((r) => r.text), !(last !== undefined && last.noEol)));
    };
  }
  if (newPath === null || s.deletion) {
    return (tree) => {
      needSafe(oldPath);
      needFile(tree, oldPath);
      tree.set(oldPath, null);
    };
  }
  const moving = oldPath !== newPath;
  return (tree) => {
    if (moving) needSafe(oldPath, newPath);
    else needSafe(oldPath);
    const text = needFile(tree, oldPath);
    if (moving) needNoFile(tree, newPath);
    const doc = readDoc(text);
    applyHunks(doc, s.hunks, strict, oldPath);
    if (moving) moveFile(tree, oldPath, newPath, writeDoc(doc));
    else tree.set(oldPath, writeDoc(doc));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC 7)

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let windowStart = 0;
  let lastPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let k = i - 1; k >= windowStart; k--) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    path ??= lastPath;
    if (path === null) throw parseError(i);
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (j >= lines.length || k >= lines.length) throw parseError(i);
    const search = lines.slice(i + 1, j);
    const replace = lines.slice(j + 1, k);
    edits.push(blockEdit(path, search, replace, strict));
    lastPath = path;
    windowStart = k + 1;
    i = k;
  }
  return edits;
}

function blockEdit(p: string, search: string[], replace: string[], strict: boolean): Edit {
  return (tree) => {
    needSafe(p);
    if (search.length === 0) {
      needNoFile(tree, p);
      tree.set(p, createdText(replace, true));
      return;
    }
    const doc = readDoc(needFile(tree, p));
    const found = findAll(doc.lines, search, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.at.length > 1) throw new Fail('ambiguous', p);
    const rows: Row[] = [...search.map((text): Row => ({ op: '-', text, noEol: false })), ...replace.map((text): Row => ({ op: '+', text, noEol: false }))];
    replaceAt(doc.lines, rows, found.at[0]!, found.tier);
    tree.set(p, writeDoc(doc));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// V4A patches (SPEC 8)

interface Chunk {
  anchor: string | null;
  rows: Row[];
  eof: boolean;
}

const V4A_SECTION = /^\*\*\* (Add|Delete|Update) File: /;

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseError(first);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last--;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw parseError(lines.length);

  const sections: Array<{ kind: string; path: string; at: number; body: number[] }> = [];
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const m = V4A_SECTION.exec(line);
    if (m !== null) {
      sections.push({ kind: m[1]!, path: stripSpaces(line.slice(m[0].length)), at: i, body: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1]!.body.push(i);
    } else if (!isBlank(line)) {
      throw parseError(i);
    }
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    const body = sec.body;
    while (body.length > 0 && isBlank(lines[body[body.length - 1]!]!)) body.pop();
    const p = sec.path;
    if (sec.kind === 'Add') {
      const content: string[] = [];
      for (const n of body) {
        const l = lines[n]!;
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (l === '') content.push('');
        else throw parseError(n);
      }
      edits.push((tree) => {
        needSafe(p);
        needNoFile(tree, p);
        tree.set(p, createdText(content, true));
      });
    } else if (sec.kind === 'Delete') {
      if (body.length > 0) throw parseError(body[0]!);
      edits.push((tree) => {
        needSafe(p);
        needFile(tree, p);
        tree.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let from = 0;
      if (body.length > 0 && lines[body[0]!]!.startsWith('*** Move to: ')) {
        moveTo = stripSpaces(lines[body[0]!]!.slice('*** Move to: '.length));
        from = 1;
      }
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (const n of body.slice(from)) {
        const l = lines[n]!;
        if (l.startsWith('@@')) {
          const anchor = stripSpaces(l.slice(2));
          open = { anchor: anchor === '' ? null : anchor, rows: [], eof: false };
          chunks.push(open);
        } else if (l === '*** End of File') {
          if (open === null) throw parseError(n);
          open.eof = true;
          open = null;
        } else if (l === '' || ' -+'.includes(l[0]!)) {
          if (open === null) {
            if (chunks.length > 0) throw parseError(n);
            open = { anchor: null, rows: [], eof: false };
            chunks.push(open);
          }
          open.rows.push({ op: l === '' ? ' ' : (l[0] as Row['op']), text: l.slice(1), noEol: false });
        } else {
          throw parseError(n);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw parseError(sec.at);
      edits.push(v4aUpdate(p, moveTo, chunks, strict));
    }
  }
  return edits;
}

function v4aUpdate(p: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (moveTo !== null) needSafe(p, moveTo);
    else needSafe(p);
    const text = needFile(tree, p);
    if (moveTo !== null) needNoFile(tree, moveTo);
    const doc = readDoc(text);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        let hit = -1;
        for (const tier of tiersFor(strict)) {
          const want = atTier(c.anchor, tier);
          for (let x = cursor; x < doc.lines.length; x++) {
            if (atTier(doc.lines[x]!, tier) === want) {
              hit = x;
              break;
            }
          }
          if (hit >= 0) break;
        }
        if (hit < 0) throw new Fail('no-match', p);
        cursor = hit + 1;
      }
      const old = oldOf(c.rows);
      let at = -1;
      let tier = 0;
      if (old.length === 0) {
        at = c.eof ? doc.lines.length : cursor;
      } else {
        for (const t of tiersFor(strict)) {
          if (c.eof) {
            const end = doc.lines.length - old.length;
            if (end >= cursor && matchesAt(doc.lines, old, end, t)) at = end;
          } else {
            for (let x = cursor; x + old.length <= doc.lines.length; x++) {
              if (matchesAt(doc.lines, old, x, t)) {
                at = x;
                break;
              }
            }
          }
          if (at >= 0) {
            tier = t;
            break;
          }
        }
        if (at < 0) throw new Fail('no-match', p);
      }
      cursor = at + replaceAt(doc.lines, c.rows, at, tier);
    }
    if (moveTo !== null) moveFile(tree, p, moveTo, writeDoc(doc));
    else tree.set(p, writeDoc(doc));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JSON edits (SPEC 9)

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      needNoFile(tree, p);
      tree.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = typeof o.new_str === 'string' ? o.new_str : '';
    return (tree) => {
      needSafe(p);
      const before = needFile(tree, p);
      const crlf = readDoc(before).br === '\r\n';
      const unify = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = unify(before);
      const needle = unify(oldStr);
      let count = 0;
      for (let k = text.indexOf(needle); k >= 0 && count < 2; k = text.indexOf(needle, k + 1)) count++;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(needle);
      const out = text.slice(0, at) + unify(newStr) + text.slice(at + needle.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line) || typeof o.new_str !== 'string') return null;
    const after = o.insert_line;
    const added = splitPatch(o.new_str);
    return (tree) => {
      needSafe(p);
      const doc = readDoc(needFile(tree, p));
      if (after < 0 || after > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(after, 0, ...added);
      tree.set(p, writeDoc(doc));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw parseError(first);
    }
    if (!Array.isArray(v)) throw parseError(first);
    for (const item of v) {
      const e = jsonEdit(item);
      if (e === null) throw parseError(first);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw parseError(i);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// The command line, the run and its report (SPEC 1, 2 and 10)

interface Outcome {
  code: number;
  out: string[];
}

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function readEdits(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'v4a') return v4aEdits(lines, strict);
  if (kind === 'search-replace') return searchReplaceEdits(lines, strict);
  return readUnified(lines).map((s) => unifiedEdit(s, strict));
}

function run(args: string[]): Outcome {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let optionsEnded = false;
  const positional: string[] = [];
  for (const a of args) {
    if (!optionsEnded && a === '--') optionsEnded = true;
    else if (!optionsEnded && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice('--format='.length))) format = a.slice('--format='.length);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else positional.push(a);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchFile = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    edits = readEdits(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const saved = new Map(tree.after);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.after.clear();
      for (const [k, v] of saved) tree.after.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  const changed = [...tree.after.keys()].filter((p) => tree.original(p) !== tree.get(p));
  const reported = new Set<string>();
  const rows: Array<[string, string]> = [];
  for (const [from, to] of tree.moves) {
    if (reported.has(from) || reported.has(to)) continue;
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      rows.push([to, `R ${from} -> ${to}`]);
      reported.add(from);
      reported.add(to);
    }
  }
  for (const p of changed) {
    if (reported.has(p)) continue;
    const mark = tree.original(p) === null ? 'A' : tree.get(p) === null ? 'D' : 'M';
    rows.push([p, `${mark} ${p}`]);
  }
  rows.sort((a, b) => byBytes(a[0], b[0]));

  if (!check) {
    for (const p of changed) if (tree.get(p) === null) rmSync(p, { force: true });
    for (const p of [...changed].sort(byBytes)) {
      const now = tree.get(p);
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r[1]), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
