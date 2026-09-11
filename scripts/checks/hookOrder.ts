/**
 * Does any component call a hook after it can already have returned?
 *
 * React counts hooks per render. A component that returns early while a modal
 * is closed, and calls more hooks once it opens, renders a different number of
 * hooks on the second render — React throws "rendered more hooks than during
 * the previous render" mid-render. With the error boundary added alongside this
 * check the app now survives that, but the screen is still dead, so catch it
 * here instead: on 2026-09-09 this exact shape in SceneAnalysisModal made every
 * click on a library video blank the whole app.
 *
 * Deliberately narrow: only hooks the component itself calls, only returns in
 * its own body. A hook inside the returned expression (`return useQuery(...)`)
 * is fine and is not reported.
 */
import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

export interface HookOrderViolation {
  file: string;
  component: string;
  /** Line of the first return that can be reached before those hooks. */
  returnLine: number;
  /** Hook calls that a render taking that return would skip. */
  hooks: string[];
}

const HOOK_NAME = /^use[A-Z]/;

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassDeclaration(node);
}

/** Returns in this body only — never inside a nested function — as [start, end). */
function ownReturnSpans(body: ts.Block, sf: ts.SourceFile): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) spans.push([node.getStart(sf), node.getEnd()]);
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return spans;
}

/** Hook calls this function makes itself, not ones inside callbacks it defines. */
function ownHookCalls(body: ts.Block, sf: ts.SourceFile): Array<{ name: string; pos: number }> {
  const calls: Array<{ name: string; pos: number }> = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      const name = ts.isIdentifier(e)
        ? e.text
        : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)
          ? e.name.text
          : null;
      if (name && HOOK_NAME.test(name)) calls.push({ name, pos: node.getStart(sf) });
    }
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return calls;
}

function tsxFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxFilesUnder(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function findHookOrderViolations(rootDir: string, repoRoot = process.cwd()): HookOrderViolation[] {
  const violations: HookOrderViolation[] = [];
  for (const file of tsxFilesUnder(rootDir)) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      const fn = node as ts.FunctionLikeDeclaration;
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && fn.body && ts.isBlock(fn.body)) {
        const hooks = ownHookCalls(fn.body, sf);
        if (hooks.length > 0) {
          const returns = ownReturnSpans(fn.body, sf);
          const firstReturn = returns.length ? Math.min(...returns.map((r) => r[0])) : Infinity;
          const skipped = hooks.filter((h) => h.pos > firstReturn && !returns.some(([a, b]) => h.pos >= a && h.pos < b));
          if (skipped.length > 0) {
            const named = (node as any).name?.getText(sf)
              ?? (node.parent && ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(sf) : "(anonymous)");
            const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
            violations.push({
              file: path.relative(repoRoot, file),
              component: named,
              returnLine: lineOf(firstReturn),
              hooks: skipped.map((h) => `${h.name}@${lineOf(h.pos)}`),
            });
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return violations;
}

export function describeViolation(v: HookOrderViolation): string {
  return `${v.file}:${v.returnLine} ${v.component} can return before ${v.hooks.length} hook(s): ${v.hooks.join(", ")}`;
}
