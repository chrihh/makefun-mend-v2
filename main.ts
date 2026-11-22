// mend v2 — one patch tool for every AI edit format.
//
// Architecture (a pipeline, deliberately unlike a single-pass design):
//
//   patch text ──► reader (one per format) ──► edit IR ──► applier ──► tree
//
// Each of the four readers (unified diff, SEARCH/REPLACE, V4A, JSON tool
// calls) only *parses*: it normalizes its format into a small common
// intermediate representation of edits (create / delete / move / splice /
// chunks / text-replace / insert). Readers never touch the file system.
//
// The applier runs the IR edits, in patch order, against a virtual tree:
// an in-memory overlay on top of the real directory. An edit that fails
// leaves the overlay untouched; the edits after it still run. Only when
// every edit has succeeded does the commit step flush the overlay to disk
// (and `--check` skips even that), which is what makes a patch atomic.
//
// All line matching lives in one place, the anchor matcher: it finds a
// block of "old" lines in a document at the first of three fuzz tiers
// (exact, trailing-whitespace-blind, fully whitespace-blind) and rewrites
// the replacement lines for that tier.
//
// The contract is SPEC.md. Node 22, standard library only. When the
// grader's MAKEFUN_ENV_URL is set, this file hands over to runner.ts
// (kept at the bottom).

import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/* ================================================================== */
/* Fatal conditions (exit 2)                                           */
/* ================================================================== */

/** Thrown for exit-2 conditions; `line` is the exact stdout line. */
class Fatal extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

const fatalParse = (lineNo: number): Fatal => new Fatal(`error: parse ${lineNo}`);

/* ================================================================== */
/* Small text utilities                                                */
/* ================================================================== */

const isBlankLine = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadIndent = (s: string): string => /^[ \t]*/.exec(s)![0];

/** A patch's lines (SPEC §3): split at \n, one trailing \r removed from
 *  each, and no empty piece after a final \n. Line numbers are 1-based
 *  indexes into this array. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** Split helper for JSON `new_str` values (SPEC §9): split at \n, one
 *  trailing \r removed per piece, no empty piece after a final \n, and an
 *  empty string has no lines at all. */
function stringLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/* ================================================================== */
/* Doc: one file as lines plus its line-break conventions (SPEC §3)    */
/* ================================================================== */

class Doc {
  lines: string[];
  /** The file's own line break. */
  eol: '\n' | '\r\n';
  /** Whether the file ends with a line break. */
  tail: boolean;

  constructor(lines: string[], eol: '\n' | '\r\n', tail: boolean) {
    this.lines = lines;
    this.eol = eol;
    this.tail = tail;
  }

  /** Parse raw file text. The break is CRLF when the first line feed
   *  follows a carriage return, LF otherwise; lines are the text split
   *  at that break; an empty file has no lines and no final break. */
  static parse(text: string): Doc {
    if (text === '') return new Doc([], '\n', false);
    const firstFeed = text.indexOf('\n');
    const eol: '\n' | '\r\n' = firstFeed > 0 && text[firstFeed - 1] === '\r' ? '\r\n' : '\n';
    const parts = text.split(eol);
    const tail = text.endsWith(eol);
    if (tail) parts.pop();
    return new Doc(parts, eol, tail);
  }

  /** A freshly created file: LF breaks, final break as given. A file of
   *  no lines is written empty whatever `tail` says. */
  static created(lines: string[], tail: boolean): Doc {
    return new Doc(lines, '\n', tail);
  }

  get isCrlf(): boolean {
    return this.eol === '\r\n';
  }

  serialize(): string {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.eol) + (this.tail ? this.eol : '');
  }
}

/* ================================================================== */
/* The anchor matcher (SPEC §5)                                        */
/* ================================================================== */

type Tier = 0 | 1 | 2;

/** The comparison key of one line at one tier. */
function keyAt(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrail(line);
  return stripBoth(line);
}

/** Every start position (overlaps included, ascending) where `needle`
 *  matches `hay` at `tier`, considering only starts >= `from`. */
function occurrencesAt(hay: string[], needle: string[], tier: Tier, from: number): number[] {
  const hits: number[] = [];
  if (needle.length === 0 || needle.length > hay.length) return hits;
  const want = needle.map((l) => keyAt(l, tier));
  for (let i = Math.max(0, from); i + needle.length <= hay.length; i += 1) {
    let ok = true;
    for (let j = 0; j < want.length; j += 1) {
      if (keyAt(hay[i + j], tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

interface Located {
  tier: Tier;
  starts: number[];
}

/** Find `needle` in `hay` at the first tier (0, then 1, then 2 — tier 0
 *  only when `strict`) at which it occurs at least once at or after
 *  `from`. Null when it occurs at no tier. */
function locate(hay: string[], needle: string[], strict: boolean, from: number): Located | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const starts = occurrencesAt(hay, needle, tier, from);
    if (starts.length > 0) return { tier, starts };
  }
  return null;
}

/** One tagged line of a splice body: context (in both old and new),
 *  deleted (old only) or added (new only). `noBreak` records that a
 *  `\ No newline at end of file` line followed this body line. */
interface BodyLine {
  tag: 'ctx' | 'del' | 'add';
  text: string;
  noBreak: boolean;
  /** True when this line came from an empty patch line (a context line
   *  whose text is empty); trailing ones are not part of a hunk body. */
  fromEmpty: boolean;
}

const oldLinesOf = (body: BodyLine[]): string[] =>
  body.filter((b) => b.tag !== 'add').map((b) => b.text);
const newLinesOf = (body: BodyLine[]): string[] =>
  body.filter((b) => b.tag !== 'del').map((b) => b.text);

/** Build the replacement lines for a match of the body's old lines at
 *  `start` in `docLines`, at `tier`. Context lines are written as the
 *  file's own matched lines; at tier 2 every other new line is
 *  re-indented from the old block's indent to the file's (SPEC §5). */
function replacementFor(docLines: string[], start: number, body: BodyLine[], tier: Tier): string[] {
  const old = oldLinesOf(body);
  const out: string[] = [];
  let oi = 0; // index into `old` of the next context line
  const fileLead = tier === 2 && old.length > 0 ? leadIndent(docLines[start]) : '';
  const patchLead = tier === 2 && old.length > 0 ? leadIndent(old[0]) : '';
  for (const b of body) {
    if (b.tag === 'del') {
      oi += 1;
      continue;
    }
    if (b.tag === 'ctx') {
      out.push(docLines[start + oi]);
      oi += 1;
      continue;
    }
    // An added line.
    let text = b.text;
    if (tier === 2 && text !== '' && !isBlankLine(text) && text.startsWith(patchLead)) {
      text = fileLead + text.slice(patchLead.length);
    }
    out.push(text);
  }
  return out;
}

/** Whether a `\` line follows the body's last context or added line —
 *  the marker that suppresses the result's final line break (SPEC §6). */
function lastNewSideNoBreak(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i].tag !== 'del') return body[i].noBreak;
  }
  return false;
}

/* ================================================================== */
/* The edit IR                                                         */
/* ================================================================== */

/** One unified-diff hunk: its body plus the A of its `@@ -A[,B] +C[,D] @@`
 *  header (B and D are not used). */
interface HunkIR {
  body: BodyLine[];
  a: number;
}

/** One V4A chunk: an optional anchor line, a body, and whether a
 *  `*** End of File` line anchors it to the end of the file. */
interface ChunkIR {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

type EditIR =
  | { op: 'create-lines'; path: string; lines: string[]; tail: boolean }
  | { op: 'create-raw'; path: string; text: string }
  | { op: 'delete'; path: string }
  | { op: 'hunks'; path: string; moveTo: string | null; hunks: HunkIR[] }
  | { op: 'chunks'; path: string; moveTo: string | null; chunks: ChunkIR[] }
  | { op: 'splice'; path: string; body: BodyLine[] }
  | { op: 'replace-text'; path: string; oldStr: string; newStr: string }
  | { op: 'insert-lines'; path: string; at: number; lines: string[] };

/** Every path an edit names, in the order they are safety-checked. */
function pathsNamed(edit: EditIR): string[] {
  switch (edit.op) {
    case 'hunks':
    case 'chunks':
      return edit.moveTo === null ? [edit.path] : [edit.path, edit.moveTo];
    default:
      return [edit.path];
  }
}

/* ================================================================== */
/* Reader: unified diffs (SPEC §6)                                     */
/* ================================================================== */

interface SectionAcc {
  gitOld: string | null;
  gitNew: string | null;
  headOld: string | null; // from `--- `
  headNew: string | null; // from `+++ `
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: HunkIR[];
}

const newSection = (gitOld: string | null, gitNew: string | null): SectionAcc => ({
  gitOld,
  gitNew,
  headOld: null,
  headNew: null,
  renFrom: null,
  renTo: null,
  newFile: false,
  delFile: false,
  hunks: [],
});

/** Extract a `--- `/`+++ ` header path: the text after the four
 *  characters, up to the first tab, surrounding spaces removed, a
 *  leading `a/` or `b/` removed; `/dev/null` becomes null. */
function headerPath(raw: string): string | null {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +/, '').replace(/ +$/, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Parse a `diff --git a/<X> b/<Y>` line into its two paths, or throw. */
function gitPaths(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (m === null) throw fatalParse(lineNo);
  return [m[1], m[2]];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function readUnified(lines: string[]): EditIR[] {
  const sections: SectionAcc[] = [];
  let sec: SectionAcc | null = null;
  let inHeader = false;
  let body: BodyLine[] | null = null;
  let bodyA = 0;

  const closeBody = (): void => {
    if (body === null || sec === null) return;
    while (body.length > 0 && body[body.length - 1].fromEmpty) body.pop();
    sec.hunks.push({ body, a: bodyA });
    body = null;
  };
  const closeSection = (): void => {
    closeBody();
    if (sec !== null) sections.push(sec);
    sec = null;
    inHeader = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const no = i + 1;
    const next = i + 1 < lines.length ? lines[i + 1] : undefined;
    const pairAhead = line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ');

    if (body !== null) {
      // Inside a hunk body: it ends at a new section's `--- `/`+++ ` pair;
      // any other line that cannot be a body line ends it too and is
      // re-read below as an outside line.
      if (pairAhead) {
        closeSection();
        sec = newSection(null, null);
        sec.headOld = headerPath(line);
        sec.headNew = headerPath(next!);
        inHeader = true;
        i += 1;
        continue;
      }
      const c = line.charAt(0);
      if (c === ' ' || c === '-' || c === '+' || c === '\\' || line === '') {
        if (c === '\\') {
          if (body.length > 0) body[body.length - 1].noBreak = true;
        } else if (line === '') {
          body.push({ tag: 'ctx', text: '', noBreak: false, fromEmpty: true });
        } else {
          body.push({
            tag: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add',
            text: line.slice(1),
            noBreak: false,
            fromEmpty: false,
          });
        }
        continue;
      }
      closeBody();
      inHeader = false;
      // fall through: re-read this line outside the body
    }

    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, no);
      closeSection();
      sec = newSection(x, y);
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw fatalParse(no);
      const m = HUNK_RE.exec(line);
      if (m === null) throw fatalParse(no);
      body = [];
      bodyA = Number(m[1]);
      inHeader = false;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (next === undefined || !next.startsWith('+++ ')) throw fatalParse(no + 1);
        sec.headOld = headerPath(line);
        sec.headNew = headerPath(next);
        i += 1;
        continue;
      }
      if (line.startsWith('+++ ')) {
        sec.headNew = headerPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renFrom = line.slice('rename from '.length);
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renTo = line.slice('rename to '.length);
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.delFile = true;
        continue;
      }
      continue; // every other header line is ignored
    }
    if (pairAhead) {
      // A `--- `/`+++ ` pair outside a header starts a new section.
      closeSection();
      sec = newSection(null, null);
      sec.headOld = headerPath(line);
      sec.headNew = headerPath(next!);
      inHeader = true;
      i += 1;
      continue;
    }
    // Anything else outside bodies and headers is ignored (prose, fences).
  }
  closeSection();

  const edits: EditIR[] = [];
  for (const s of sections) {
    const oldPath = s.headOld ?? s.renFrom ?? s.gitOld;
    const newPath = s.headNew ?? s.renTo ?? s.gitNew;
    const isCreate = oldPath === null || s.newFile;
    const isDelete = newPath === null || s.delFile;
    if (isCreate) {
      const target = newPath ?? oldPath ?? '';
      const adds: BodyLine[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.tag === 'add') adds.push(b);
      edits.push({
        op: 'create-lines',
        path: target,
        lines: adds.map((b) => b.text),
        tail: !(adds.length > 0 && adds[adds.length - 1].noBreak),
      });
    } else if (isDelete) {
      edits.push({ op: 'delete', path: oldPath ?? '' });
    } else if (oldPath !== newPath) {
      edits.push({ op: 'hunks', path: oldPath ?? '', moveTo: newPath, hunks: s.hunks });
    } else {
      edits.push({ op: 'hunks', path: oldPath ?? '', moveTo: null, hunks: s.hunks });
    }
  }
  return edits;
}

/* ================================================================== */
/* Reader: SEARCH/REPLACE blocks (SPEC §7)                             */
/* ================================================================== */

function readSearchReplace(lines: string[]): EditIR[] {
  const edits: EditIR[] = [];
  let prevEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (stripTrail(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    // The path: the nearest line before this one and after the previous
    // block that is not blank and does not open a code fence.
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw fatalParse(searchNo);
    // Find ======= and then >>>>>>> REPLACE.
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (stripTrail(lines[j]) === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (stripTrail(lines[j]) === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw fatalParse(searchNo);
    const oldPart = lines.slice(i + 1, eq);
    const newPart = lines.slice(eq + 1, rep);
    if (oldPart.length === 0) {
      edits.push({ op: 'create-lines', path, lines: newPart, tail: true });
    } else {
      const body: BodyLine[] = [
        ...oldPart.map((t): BodyLine => ({ tag: 'del', text: t, noBreak: false, fromEmpty: false })),
        ...newPart.map((t): BodyLine => ({ tag: 'add', text: t, noBreak: false, fromEmpty: false })),
      ];
      edits.push({ op: 'splice', path, body });
    }
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ================================================================== */
/* Reader: V4A patches (SPEC §8)                                       */
/* ================================================================== */

const V4A_SECTIONS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '] as const;

function v4aHeader(line: string): (typeof V4A_SECTIONS)[number] | null {
  for (const h of V4A_SECTIONS) if (line.startsWith(h)) return h;
  return null;
}

function readV4a(lines: string[]): EditIR[] {
  let begin = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) if (!isBlankLine(lines[i])) { begin = i; break; }
  for (let i = lines.length - 1; i >= 0; i -= 1) if (!isBlankLine(lines[i])) { end = i; break; }
  if (begin < 0) throw fatalParse(1);
  if (lines[begin].trim() !== '*** Begin Patch') throw fatalParse(begin + 1);
  if (end < 0 || lines[end].trim() !== '*** End Patch') throw fatalParse(lines.length + 1);

  const edits: EditIR[] = [];
  let i = begin + 1;
  while (i < end) {
    if (isBlankLine(lines[i])) {
      i += 1;
      continue;
    }
    const header = v4aHeader(lines[i]);
    if (header === null) throw fatalParse(i + 1);
    const headerNo = i + 1;
    const path = lines[i].slice(header.length).trim();
    // Collect this section's lines (with their numbers) up to the next
    // section header or the End Patch line.
    const raw: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < end && v4aHeader(lines[j]) === null) {
      raw.push({ text: lines[j], no: j + 1 });
      j += 1;
    }
    // Blank lines at the end of a section are not part of it — blank
    // meaning empty or only whitespace, so a trailing context line that
    // holds nothing but spaces goes with them.
    while (raw.length > 0 && isBlankLine(raw[raw.length - 1].text)) raw.pop();

    if (header === '*** Add File: ') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw fatalParse(r.no);
      }
      edits.push({ op: 'create-lines', path, lines: fileLines, tail: true });
    } else if (header === '*** Delete File: ') {
      for (const r of raw) if (r.text !== '') throw fatalParse(r.no);
      edits.push({ op: 'delete', path });
    } else {
      edits.push(readV4aUpdate(path, raw, headerNo));
    }
    i = j;
  }
  return edits;
}

function readV4aUpdate(
  path: string,
  raw: { text: string; no: number }[],
  headerNo: number,
): EditIR {
  let moveTo: string | null = null;
  let k = 0;
  while (k < raw.length && raw[k].text === '') k += 1;
  if (k < raw.length && raw[k].text.startsWith('*** Move to: ')) {
    moveTo = raw[k].text.slice('*** Move to: '.length).trim();
    k += 1;
  }
  const chunks: ChunkIR[] = [];
  let cur: ChunkIR | null = null;
  let closedAny = false;
  const close = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
      closedAny = true;
    }
  };
  for (; k < raw.length; k += 1) {
    const { text, no } = raw[k];
    if (text.trim() === '*** End of File') {
      if (cur === null) throw fatalParse(no);
      cur.eof = true;
      close();
      continue;
    }
    if (text.startsWith('@@')) {
      close();
      const anchorText = text.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
      continue;
    }
    const c = text.charAt(0);
    if (c === ' ' || c === '-' || c === '+' || text === '') {
      if (cur === null) {
        // A body line may open only the first chunk implicitly.
        if (closedAny || chunks.length > 0) throw fatalParse(no);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push({
        tag: text === '' ? 'ctx' : c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add',
        text: text === '' ? '' : text.slice(1),
        noBreak: false,
        fromEmpty: text === '',
      });
      continue;
    }
    throw fatalParse(no);
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw fatalParse(headerNo);
  return { op: 'chunks', path, moveTo, chunks };
}

/* ================================================================== */
/* Reader: JSON edits (SPEC §9)                                        */
/* ================================================================== */

function jsonEdit(value: unknown): EditIR | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const path = o.path;
  const command = o.command;
  if (typeof path !== 'string' || typeof command !== 'string') return null;
  if (command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { op: 'create-raw', path, text: o.file_text };
  }
  if (command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { op: 'replace-text', path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { op: 'insert-lines', path, at: o.insert_line, lines: stringLines(o.new_str) };
  }
  return null;
}

function readJson(text: string, lines: string[]): EditIR[] {
  // Array form when the first non-whitespace character is `[`.
  let arrayLine = 1;
  let isArray = false;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trimStart();
    if (t === '') continue;
    isArray = t.startsWith('[');
    arrayLine = i + 1;
    break;
  }
  if (isArray) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw fatalParse(arrayLine);
    }
    if (!Array.isArray(parsed)) throw fatalParse(arrayLine);
    const edits: EditIR[] = [];
    for (const el of parsed) {
      const e = jsonEdit(el);
      if (e === null) throw fatalParse(arrayLine);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines form: one edit object a line, blank lines ignored.
  const edits: EditIR[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlankLine(lines[i])) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      throw fatalParse(i + 1);
    }
    const e = jsonEdit(parsed);
    if (e === null) throw fatalParse(i + 1);
    edits.push(e);
  }
  return edits;
}

/* ================================================================== */
/* Format detection (SPEC §4)                                          */
/* ================================================================== */

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): FormatName {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlankLine(lines[i])) {
      first = i;
      break;
    }
  }
  if (first >= 0) {
    if (lines[first].trim() === '*** Begin Patch') return 'v4a';
    const c = lines[first].trimStart().charAt(0);
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) if (stripTrail(l) === '<<<<<<< SEARCH') return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  throw new Fatal('error: format');
}

function readPatch(format: FormatName, text: string, lines: string[]): EditIR[] {
  const edits =
    format === 'unified'
      ? readUnified(lines)
      : format === 'search-replace'
        ? readSearchReplace(lines)
        : format === 'v4a'
          ? readV4a(lines)
          : readJson(text, lines);
  if (edits.length === 0) throw fatalParse(1);
  return edits;
}

/* ================================================================== */
/* The virtual tree and the transactional applier (SPEC §10)           */
/* ================================================================== */

/** A safe path (SPEC §3): not empty, no leading `/`, no `\`, and no
 *  empty, `.` or `..` segment. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

interface Failure {
  code: string;
  path: string;
}

/** The tree as an overlay: `overlay` holds the post-edit content of every
 *  touched path (null = deleted); `base` caches each touched path's
 *  original on-disk content (undefined = it did not exist). Nothing is
 *  written to disk until every edit has succeeded. */
class Tree {
  private base = new Map<string, string | undefined>();
  private overlay = new Map<string, string | null>();
  /** Successful move pairs, in patch order, for the `R` output lines. */
  readonly moves: [string, string][] = [];

  private disk(path: string): string | undefined {
    if (!this.base.has(path)) {
      let content: string | undefined;
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        content = undefined;
      }
      this.base.set(path, content);
    }
    return this.base.get(path);
  }

  read(path: string): string | undefined {
    if (this.overlay.has(path)) {
      const v = this.overlay.get(path);
      return v === null ? undefined : v;
    }
    return this.disk(path);
  }

  exists(path: string): boolean {
    return this.read(path) !== undefined;
  }

  put(path: string, text: string): void {
    this.disk(path); // make sure the original is cached for the report
    this.overlay.set(path, text);
  }

  remove(path: string): void {
    this.disk(path);
    this.overlay.set(path, null);
  }

  /** The original content of a path (undefined = did not exist). */
  before(path: string): string | undefined {
    return this.disk(path);
  }

  /** The final content of a touched path (undefined = does not exist). */
  after(path: string): string | undefined {
    if (!this.overlay.has(path)) return this.disk(path);
    const v = this.overlay.get(path);
    return v === null ? undefined : v;
  }

  touchedPaths(): string[] {
    return [...this.overlay.keys()];
  }

  /** Write every change to disk. Only called when no edit failed and
   *  `--check` was not given. */
  commit(): void {
    for (const [path, v] of this.overlay) {
      if (v === null) {
        rmSync(path, { force: true });
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, v);
      }
    }
  }
}

/** Apply one unified section's hunks to a document, in order, each to
 *  the result of the ones before it (SPEC §6). Returns the failure code
 *  ('no-match') or null. Mutates `doc` only through the returned value:
 *  the caller passes a scratch copy. */
function applyHunks(doc: Doc, hunks: HunkIR[], strict: boolean): string | null {
  let lines = doc.lines;
  let tail = doc.tail;
  let d = 0; // sum of (new length - old length) over hunks applied so far
  for (const hunk of hunks) {
    const old = oldLinesOf(hunk.body);
    const fresh = newLinesOf(hunk.body);
    if (old.length === 0) {
      // Pure insertion: after the first A + d lines.
      const at = Math.min(Math.max(hunk.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...fresh, ...lines.slice(at)];
      if (atEnd && fresh.length > 0) tail = !lastNewSideNoBreak(hunk.body);
      if (atEnd && fresh.length === 0 && lines.length === 0) tail = false;
    } else {
      const found = locate(lines, old, strict, 0);
      if (found === null) return 'no-match';
      const target = hunk.a - 1 + d;
      let start = found.starts[0];
      for (const s of found.starts) {
        if (Math.abs(s - target) < Math.abs(start - target)) start = s;
      }
      const repl = replacementFor(lines, start, hunk.body, found.tier);
      const runsToEnd = start + old.length === lines.length;
      lines = [...lines.slice(0, start), ...repl, ...lines.slice(start + old.length)];
      if (runsToEnd) {
        tail = lines.length === 0 ? false : !lastNewSideNoBreak(hunk.body);
      }
    }
    d += fresh.length - old.length;
  }
  doc.lines = lines;
  doc.tail = tail;
  return null;
}

/** Apply one V4A section's chunks with its cursor (SPEC §8). */
function applyChunks(doc: Doc, chunks: ChunkIR[], strict: boolean): string | null {
  let lines = doc.lines;
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      // First line at or after the cursor equal to the anchor, at the
      // first tier where one is.
      const tiers: Tier[] = strict ? [0] : [0, 1, 2];
      let at = -1;
      for (const tier of tiers) {
        for (let i = cursor; i < lines.length; i += 1) {
          if (keyAt(lines[i], tier) === keyAt(chunk.anchor, tier)) {
            at = i;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) return 'no-match';
      cursor = at + 1;
    }
    const old = oldLinesOf(chunk.body);
    if (old.length === 0) {
      const fresh = newLinesOf(chunk.body);
      const at = chunk.eof ? lines.length : Math.min(cursor, lines.length);
      lines = [...lines.slice(0, at), ...fresh, ...lines.slice(at)];
      cursor = at + fresh.length;
      continue;
    }
    const found = locate(lines, old, strict, cursor);
    if (found === null) return 'no-match';
    const starts = chunk.eof
      ? found.starts.filter((s) => s + old.length === lines.length)
      : found.starts;
    if (starts.length === 0) return 'no-match';
    const start = starts[0];
    const repl = replacementFor(lines, start, chunk.body, found.tier);
    lines = [...lines.slice(0, start), ...repl, ...lines.slice(start + old.length)];
    cursor = start + repl.length;
  }
  doc.lines = lines;
  return null;
}

/** Apply one edit to the tree. Returns its failure, or null on success.
 *  The edit changes nothing when it fails. */
function applyEdit(tree: Tree, edit: EditIR, strict: boolean): Failure | null {
  // Every path the edit names is checked for safety before anything else.
  for (const p of pathsNamed(edit)) {
    if (!isSafePath(p)) return { code: 'unsafe', path: p };
  }
  switch (edit.op) {
    case 'create-lines': {
      if (tree.exists(edit.path)) return { code: 'exists', path: edit.path };
      tree.put(edit.path, Doc.created(edit.lines, edit.tail).serialize());
      return null;
    }
    case 'create-raw': {
      if (tree.exists(edit.path)) return { code: 'exists', path: edit.path };
      tree.put(edit.path, edit.text);
      return null;
    }
    case 'delete': {
      if (!tree.exists(edit.path)) return { code: 'missing', path: edit.path };
      tree.remove(edit.path);
      return null;
    }
    case 'hunks':
    case 'chunks': {
      const content = tree.read(edit.path);
      if (content === undefined) return { code: 'missing', path: edit.path };
      if (edit.moveTo !== null && tree.exists(edit.moveTo)) {
        return { code: 'exists', path: edit.moveTo };
      }
      const doc = Doc.parse(content);
      const fail =
        edit.op === 'hunks'
          ? applyHunks(doc, edit.hunks, strict)
          : applyChunks(doc, edit.chunks, strict);
      if (fail !== null) return { code: fail, path: edit.path };
      if (edit.moveTo !== null) {
        tree.put(edit.moveTo, doc.serialize());
        tree.remove(edit.path);
        tree.moves.push([edit.path, edit.moveTo]);
      } else {
        tree.put(edit.path, doc.serialize());
      }
      return null;
    }
    case 'splice': {
      const content = tree.read(edit.path);
      if (content === undefined) return { code: 'missing', path: edit.path };
      const doc = Doc.parse(content);
      const old = oldLinesOf(edit.body);
      const found = locate(doc.lines, old, strict, 0);
      if (found === null) return { code: 'no-match', path: edit.path };
      if (found.starts.length > 1) return { code: 'ambiguous', path: edit.path };
      const start = found.starts[0];
      const repl = replacementFor(doc.lines, start, edit.body, found.tier);
      doc.lines = [
        ...doc.lines.slice(0, start),
        ...repl,
        ...doc.lines.slice(start + old.length),
      ];
      tree.put(edit.path, doc.serialize());
      return null;
    }
    case 'replace-text': {
      const content = tree.read(edit.path);
      if (content === undefined) return { code: 'missing', path: edit.path };
      const crlf = Doc.parse(content).isCrlf;
      const norm = (s: string): string => (crlf ? s.replace(/\r\n/g, '\n') : s);
      const hay = norm(content);
      const needle = norm(edit.oldStr);
      let count = 0;
      let at = -1;
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
        count += 1;
        at = i;
        if (count > 1) break;
      }
      if (count === 0) return { code: 'no-match', path: edit.path };
      if (count > 1) return { code: 'ambiguous', path: edit.path };
      const replaced = hay.slice(0, at) + norm(edit.newStr) + hay.slice(at + needle.length);
      tree.put(edit.path, crlf ? replaced.replace(/\n/g, '\r\n') : replaced);
      return null;
    }
    case 'insert-lines': {
      const content = tree.read(edit.path);
      if (content === undefined) return { code: 'missing', path: edit.path };
      const doc = Doc.parse(content);
      if (edit.at < 0 || edit.at > doc.lines.length) {
        return { code: 'no-match', path: edit.path };
      }
      doc.lines = [
        ...doc.lines.slice(0, edit.at),
        ...edit.lines,
        ...doc.lines.slice(edit.at),
      ];
      tree.put(edit.path, doc.serialize());
      return null;
    }
  }
}

/* ================================================================== */
/* The change report (SPEC §2)                                         */
/* ================================================================== */

/** Byte order of paths (UTF-8). UTF-8 byte order equals code-point
 *  order, which is also JS string `<` order, so a plain compare works. */
const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function report(tree: Tree): string[] {
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    if (
      tree.before(oldP) !== undefined &&
      tree.after(oldP) === undefined &&
      tree.before(newP) === undefined &&
      tree.after(newP) !== undefined
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const path of tree.touchedPaths()) {
    if (consumed.has(path)) continue;
    const b = tree.before(path);
    const a = tree.after(path);
    if (b === undefined && a !== undefined) rows.push({ key: path, line: `A ${path}` });
    else if (b !== undefined && a === undefined) rows.push({ key: path, line: `D ${path}` });
    else if (b !== undefined && a !== undefined && b !== a) {
      rows.push({ key: path, line: `M ${path}` });
    }
  }
  rows.sort((x, y) => byBytes(x.key, y.key));
  const n = rows.length;
  return [...rows.map((r) => r.line), n === 1 ? 'ok: 1 file' : `ok: ${n} files`];
}

/* ================================================================== */
/* Invocation (SPEC §1) and the main run                               */
/* ================================================================== */

interface Options {
  format: FormatName | 'auto';
  check: boolean;
  strict: boolean;
  patchPath: string | null; // null = read stdin
}

function parseArgs(argv: string[]): Options {
  let format: FormatName | 'auto' = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let positional: string | null = null;
  let afterDashDash = false;
  for (const arg of argv) {
    if (!afterDashDash && arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) throw new Fatal('error: usage');
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) throw new Fatal('error: usage');
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) throw new Fatal('error: usage');
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') {
          throw new Fatal('error: usage');
        }
        format = v;
      } else {
        throw new Fatal('error: usage');
      }
      continue;
    }
    if (positional !== null) throw new Fatal('error: usage');
    positional = arg;
  }
  return { format, check, strict, patchPath: positional };
}

function emit(lines: string[]): void {
  writeSync(1, lines.map((l) => l + '\n').join(''));
}

function main(argv: string[]): number {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof Fatal) {
      emit([e.line]);
      return 2;
    }
    throw e;
  }

  let text: string;
  if (opts.patchPath === null || opts.patchPath === '-') {
    text = readFileSync(0, 'utf8');
  } else {
    try {
      text = readFileSync(opts.patchPath, 'utf8');
    } catch {
      emit(['error: no-patch']);
      return 2;
    }
  }

  let edits: EditIR[];
  try {
    const lines = patchLines(text);
    const format = opts.format === 'auto' ? detectFormat(lines) : opts.format;
    edits = readPatch(format, text, lines);
  } catch (e) {
    if (e instanceof Fatal) {
      emit([e.line]);
      return 2;
    }
    throw e;
  }

  const tree = new Tree();
  const failures: Failure[] = [];
  for (const edit of edits) {
    const f = applyEdit(tree, edit, opts.strict);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    emit([
      ...failures.map((f) => `error: ${f.code} ${f.path}`),
      `failed: ${failures.length} of ${edits.length} edits`,
    ]);
    return 1;
  }
  if (!opts.check) tree.commit();
  emit(report(tree));
  return 0;
}

/* ================================================================== */
/* Trial hand-over: when the grader sets MAKEFUN_ENV_URL, runner.ts    */
/* runs the checks; otherwise this file is the CLI.                    */
/* ================================================================== */

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  process.exitCode = main(process.argv.slice(2));
}
