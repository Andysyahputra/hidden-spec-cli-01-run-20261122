// mend: one patch tool for every AI edit format.
//
// Reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the
// lines each edit names (exact first, then two whitespace-tolerant tiers),
// and applies every edit or none of them. Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// The working directory is the root of the tree being patched. SPEC.md in
// this repository is the whole contract; this file implements sections 1-10
// of it, in order: invocation, output and exit codes, files and paths,
// format detection, line matching, the four formats, order and atomicity.
//
// When MAKEFUN_ENV_URL is set this file hands a trial over to runner.ts
// (see the last lines below); that hand-over is kept as the kit ships it.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse/usage failure that exits 2 with one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed; reported on an exit-1 line. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and no segment is empty, . or ... */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Remove one leading a/ or b/ segment, as unified headers write paths. */
function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after a --- or +++ marker: text after the marker, up to a tab, spaces removed. */
function markerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** One file's lines, its line break, and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  ends: boolean;
}

function docFrom(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const parts = text.split(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function docTo(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.ends ? d.br : '');
}

/** The tree as the edits leave it: `now` holds every path an edit touched (null: deleted). */
class Tree {
  private seen = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];

  orig(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  cur(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.orig(p);
  }

  doc(p: string): Doc {
    return docFrom(this.cur(p) ?? '');
  }

  setDoc(p: string, d: Doc): void {
    this.now.set(p, docTo(d));
  }
}

type EditFn = (tree: Tree) => void;

/** Does file line a equal old line b at the given tier? */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position at which oldLines occur in lines at a tier, from `from` on. */
function occurrences(lines: string[], oldLines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = from; i + oldLines.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (!lineEq(lines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which oldLines occur, with its positions. */
function firstTier(lines: string[], oldLines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(lines, oldLines, tier, from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One line of a hunk or chunk: context (in both old and new), deleted, added, or a backslash line. */
type Item = { kind: 'ctx' | 'del' | 'add' | 'bs'; text: string };

const oldLinesOf = (items: Item[]): string[] => items.filter((x) => x.kind !== 'add' && x.kind !== 'bs').map((x) => x.text);

/**
 * The new lines of a hunk/chunk at a matched position. A context line is the
 * file's own matched line, never the patch's. At tier 2 every other line is
 * re-indented: the leading whitespace of the old block's first line is
 * replaced by that of the file's first matched line.
 */
function buildNew(items: Item[], fileLines: string[], at: number, tier: number): string[] {
  const oldItems = items.filter((x) => x.kind !== 'add' && x.kind !== 'bs');
  const pLead = oldItems.length > 0 ? leadWs(oldItems[0]!.text) : '';
  const fLead = oldItems.length > 0 ? leadWs(fileLines[at] ?? '') : '';
  const out: string[] = [];
  let oldPos = 0;
  for (const it of items) {
    if (it.kind === 'add') {
      if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(pLead)) {
        out.push(fLead + it.text.slice(pLead.length));
      } else {
        out.push(it.text);
      }
    } else if (it.kind === 'ctx') {
      out.push(fileLines[at + oldPos]!);
    }
    if (it.kind !== 'add' && it.kind !== 'bs') oldPos += 1;
  }
  return out;
}

/** Re-indent plain new lines (SEARCH/REPLACE) the same way buildNew does for added lines. */
function reindentPlain(newLines: string[], oldLines: string[], fileLines: string[], at: number, tier: number): string[] {
  if (tier !== 2 || oldLines.length === 0) return [...newLines];
  const pLead = leadWs(oldLines[0]!);
  const fLead = leadWs(fileLines[at] ?? '');
  return newLines.map((l) => (l !== '' && l.trim() !== '' && l.startsWith(pLead) ? fLead + l.slice(pLead.length) : l));
}

/** Was the hunk's last context/add line immediately followed by a backslash line? */
function backslashAfterLast(items: Item[], kinds: ('ctx' | 'add')[]): boolean {
  for (let k = items.length - 1; k >= 0; k -= 1) {
    if (kinds.includes(items[k]!.kind as 'ctx' | 'add')) {
      return k + 1 < items.length && items[k + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Detect the patch format from its text (section 4). */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

function jsonEditFrom(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (t) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (t.cur(p) !== null) throw new Fail('exists', p);
      t.now.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (t) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      const before = t.cur(p);
      if (before === null) throw new Fail('missing', p);
      const lfAt = before.indexOf('\n');
      const crlf = lfAt > 0 && before[lfAt - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const hay = norm(before);
      const needle = norm(oldStr);
      let count = 0;
      for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = hay.indexOf(needle);
      const out = hay.slice(0, at) + norm(newStr) + hay.slice(at + needle.length);
      t.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return (t) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      const before = t.cur(p);
      if (before === null) throw new Fail('missing', p);
      const d = docFrom(before);
      if (lineNo < 0 || lineNo > d.lines.length) throw new Fail('no-match', p);
      d.lines.splice(lineNo, 0, ...add);
      t.setDoc(p, d);
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditFrom(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditFrom(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  items: Item[];
}

interface USection {
  oldP: string | null;
  newP: string | null;
  diffOld: string | null;
  diffNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: USection[] = [];
  const fresh = (): USection => ({
    oldP: null,
    newP: null,
    diffOld: null,
    diffNew: null,
    renameOld: null,
    renameNew: null,
    createFlag: false,
    deleteFlag: false,
    hunks: [],
  });
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*|)$/;
  // Paths may hold spaces, so take the last ' b/' as the separator between the two paths.
  const diffRe = /^diff --git a\/(.+) b\/(.+)$/;
  let cur: USection | null = null;
  let inHunks = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHunks = false;
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), items: [] };
      cur.hunks.push(hunk);
      inHunks = true;
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '') {
          hunk.items.push({ kind: 'ctx', text: '' });
          i += 1;
        } else if (bl.startsWith(' ')) {
          hunk.items.push({ kind: 'ctx', text: bl.slice(1) });
          i += 1;
        } else if (bl.startsWith('-')) {
          hunk.items.push({ kind: 'del', text: bl.slice(1) });
          i += 1;
        } else if (bl.startsWith('+')) {
          hunk.items.push({ kind: 'add', text: bl.slice(1) });
          i += 1;
        } else if (bl.startsWith('\\')) {
          hunk.items.push({ kind: 'bs', text: bl });
          i += 1;
        } else {
          break;
        }
      }
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.items.pop();
        else break;
      }
      continue;
    }

    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !inHunks && cur.oldP === null && cur.newP === null) {
        cur.oldP = stripPrefix(markerPath(line));
        cur.newP = stripPrefix(markerPath(lines[i + 1]!));
      } else {
        cur = fresh();
        cur.oldP = stripPrefix(markerPath(line));
        cur.newP = stripPrefix(markerPath(lines[i + 1]!));
        sections.push(cur);
        inHunks = false;
      }
      i += 2;
      continue;
    }

    if (cur === null) {
      i += 1;
      continue;
    }

    if (!inHunks) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.deleteFlag = true;
      i += 1;
      continue;
    }

    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: USection, strict: boolean): EditFn {
  return (t) => {
    let oldP: string | null;
    let newP: string | null;
    if (sec.oldP !== null || sec.newP !== null) {
      oldP = sec.oldP;
      newP = sec.newP;
    } else if (sec.renameOld !== null || sec.renameNew !== null) {
      oldP = sec.renameOld;
      newP = sec.renameNew;
    } else {
      oldP = sec.diffOld;
      newP = sec.diffNew;
    }
    if (oldP === null || newP === null) throw new Fail('missing', oldP ?? newP ?? '');
    if (oldP !== '/dev/null' && !isSafe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== '/dev/null' && !isSafe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === '/dev/null' || sec.createFlag;
    const isDelete = newP === '/dev/null' || sec.deleteFlag;

    if (isCreate) {
      if (t.cur(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'add') plus.push(it.text);
      let ends = false;
      if (plus.length > 0) {
        ends = true;
        for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
          const h = sec.hunks[hi]!;
          if (h.items.some((x) => x.kind === 'add')) {
            ends = !backslashAfterLast(h.items, ['add']);
            break;
          }
        }
      }
      t.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
      return;
    }

    if (isDelete) {
      if (t.cur(oldP) === null) throw new Fail('missing', oldP);
      t.now.set(oldP, null);
      return;
    }

    const isMove = oldP !== newP;
    if (isMove) {
      if (t.cur(oldP) === null) throw new Fail('missing', oldP);
      if (t.cur(newP) !== null) throw new Fail('exists', newP);
    } else if (t.cur(oldP) === null) {
      throw new Fail('missing', oldP);
    }

    const doc = t.doc(oldP);
    let shift = 0;
    for (const h of sec.hunks) {
      const oLines = oldLinesOf(h.items);
      const nCount = h.items.filter((x) => x.kind === 'ctx' || x.kind === 'add').length;
      if (oLines.length === 0) {
        const at = Math.min(h.a + shift, doc.lines.length);
        const newLines = h.items.filter((x) => x.kind === 'add').map((x) => x.text);
        const atEnd = at === doc.lines.length;
        doc.lines.splice(at, 0, ...newLines);
        if (atEnd && newLines.length > 0) doc.ends = !backslashAfterLast(h.items, ['ctx', 'add']);
        shift += nCount;
        continue;
      }
      const found = firstTier(doc.lines, oLines, strict);
      if (!found) throw new Fail('no-match', oldP);
      const target = h.a - 1 + shift;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const newLines = buildNew(h.items, doc.lines, best, found.tier);
      const touchesEnd = best + oLines.length === doc.lines.length;
      doc.lines.splice(best, oLines.length, ...newLines);
      if (touchesEnd) doc.ends = !backslashAfterLast(h.items, ['ctx', 'add']);
      shift += nCount - oLines.length;
    }
    const out = docTo(doc);
    if (isMove) {
      t.now.set(newP, out);
      t.now.set(oldP, null);
      t.moves.push({ old: oldP, nw: newP });
    } else {
      t.now.set(oldP, out);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function searchEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (t) => {
    if (!isSafe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (t.cur(path) !== null) throw new Fail('exists', path);
      t.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = t.cur(path);
    if (before === null) throw new Fail('missing', path);
    const doc = docFrom(before);
    const found = firstTier(doc.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const repl = reindentPlain(newLines, oldLines, doc.lines, at, found.tier);
    doc.lines.splice(at, oldLines.length, ...repl);
    t.setDoc(path, doc);
  };
}

function parseSearch(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      // A closing marker or another SEARCH line before any separator means
      // this block never had one: the separator belongs to no later block.
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

function vAddEdit(path: string, fileLines: string[]): EditFn {
  return (t) => {
    if (!isSafe(path)) throw new Fail('unsafe', path);
    if (t.cur(path) !== null) throw new Fail('exists', path);
    t.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): EditFn {
  return (t) => {
    if (!isSafe(path)) throw new Fail('unsafe', path);
    if (t.cur(path) === null) throw new Fail('missing', path);
    t.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): EditFn {
  return (t) => {
    if (!isSafe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = t.cur(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && t.cur(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = docFrom(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < doc.lines.length; k += 1) {
            if (lineEq(doc.lines[k]!, ch.anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found !== null) break;
        }
        if (found === null) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const oLines = oldLinesOf(ch.items);
      if (oLines.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const newLines = ch.items.filter((x) => x.kind === 'add').map((x) => x.text);
        doc.lines.splice(at, 0, ...newLines);
        cursor = at + newLines.length;
        continue;
      }
      let chosen: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        const occ = occurrences(doc.lines, oLines, tier, cursor);
        const good = ch.eof ? occ.filter((p) => p + oLines.length === doc.lines.length) : occ;
        if (good.length > 0) {
          chosen = { tier, pos: good[0]! };
          break;
        }
      }
      if (!chosen) throw new Fail('no-match', path);
      const newLines = buildNew(ch.items, doc.lines, chosen.pos, chosen.tier);
      doc.lines.splice(chosen.pos, oLines.length, ...newLines);
      cursor = chosen.pos + newLines.length;
    }
    const out = docTo(doc);
    if (moveTo !== null) {
      t.now.set(moveTo, out);
      t.now.set(path, null);
      t.moves.push({ old: path, nw: moveTo });
    } else {
      t.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    const secLine = i;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    i += 1;
    const raw: string[] = [];
    const rawIdx: number[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(l);
      rawIdx.push(i);
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) {
      raw.pop();
      rawIdx.pop();
    }
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${rawIdx[k]! + 1}`);
      }
      edits.push(vAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      const bad = raw.findIndex((l) => !isBlank(l));
      if (bad >= 0) throw new Exit2(`error: parse ${rawIdx[bad]! + 1}`);
      edits.push(vDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      const flush = (): void => {
        if (curChunk !== null) {
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      for (let k = start; k < raw.length; k += 1) {
        const l = raw[k]!;
        const ln = rawIdx[k]! + 1;
        if (l.startsWith('@@')) {
          flush();
          const anchorText = l.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, items: [], eof: false };
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (curChunk === null) curChunk = { anchor: null, items: [], eof: true };
          else curChunk.eof = true;
          flush();
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) curChunk = { anchor: null, items: [], eof: false };
          if (l === '') curChunk.items.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) curChunk.items.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) curChunk.items.push({ kind: 'del', text: l.slice(1) });
          else curChunk.items.push({ kind: 'add', text: l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      flush();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine + 1}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, exit codes and the all-or-nothing write (sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearch(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  const changed: { key: string; line: string }[] = [];
  const inMove = new Set<string>();
  for (const mv of tree.moves) {
    if (tree.orig(mv.old) !== null && tree.cur(mv.old) === null && tree.orig(mv.nw) === null && tree.cur(mv.nw) !== null) {
      changed.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      inMove.add(mv.old);
      inMove.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (inMove.has(p)) continue;
    const was = tree.orig(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);

  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.orig(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
