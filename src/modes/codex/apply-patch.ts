import { dirname, isAbsolute } from "node:path";

import type { WorkspaceSandbox } from "../../sandbox/workspace.js";

const MAX_PATCH_BYTES = 4 * 1024 * 1024;

type AddOperation = { type: "add"; path: string; content: string };
type DeleteOperation = { type: "delete"; path: string };
type UpdateOperation = { type: "update"; path: string; moveTo?: string; hunks: Hunk[] };
type PatchOperation = AddOperation | DeleteOperation | UpdateOperation;
type HunkLine = { kind: "context" | "add" | "delete"; text: string };
type Hunk = { hint?: string; lines: HunkLine[] };

function patchPath(value: string): string {
  const path = value.trim();
  if (path.length === 0 || isAbsolute(path) || path.includes("\0")) {
    throw new Error(`invalid patch path: ${value}`);
  }
  return path;
}

// The parser follows Codex's line-oriented apply_patch grammar one production at a time.
// eslint-disable-next-line complexity
export function parseApplyPatch(source: string): PatchOperation[] {
  if (Buffer.byteLength(source) > MAX_PATCH_BYTES) throw new Error("patch is too large");
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  if (lines.shift() !== "*** Begin Patch") throw new Error("patch must start with *** Begin Patch");
  if (lines.at(-1) === "") lines.pop();
  if (lines.pop() !== "*** End Patch") throw new Error("patch must end with *** End Patch");

  const operations: PatchOperation[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index++];
    if (header?.startsWith("*** Add File: ") === true) {
      const path = patchPath(header.slice("*** Add File: ".length));
      const content: string[] = [];
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        const line = lines[index++];
        if (line?.startsWith("+") !== true)
          throw new Error(`add-file line must start with +: ${path}`);
        content.push(line.slice(1));
      }
      operations.push({ type: "add", path, content: `${content.join("\n")}\n` });
      continue;
    }
    if (header?.startsWith("*** Delete File: ") === true) {
      operations.push({
        type: "delete",
        path: patchPath(header.slice("*** Delete File: ".length)),
      });
      continue;
    }
    if (header?.startsWith("*** Update File: ") === true) {
      const operation: UpdateOperation = {
        type: "update",
        path: patchPath(header.slice("*** Update File: ".length)),
        hunks: [],
      };
      const moveLine = lines[index];
      if (moveLine?.startsWith("*** Move to: ") === true) {
        operation.moveTo = patchPath(moveLine.slice("*** Move to: ".length));
        index += 1;
      }
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        const hunkHeader = lines[index++];
        if (hunkHeader?.startsWith("@@") !== true) {
          throw new Error(`update hunk must start with @@: ${operation.path}`);
        }
        const hint = hunkHeader.slice(2).trim();
        const hunk: Hunk = { ...(hint.length === 0 ? {} : { hint }), lines: [] };
        while (
          index < lines.length &&
          !lines[index]?.startsWith("@@") &&
          !lines[index]?.startsWith("*** ")
        ) {
          const line = lines[index];
          index += 1;
          if (line === undefined) throw new Error(`unexpected end of patch: ${operation.path}`);
          const marker = line[0];
          if (marker !== " " && marker !== "+" && marker !== "-") {
            throw new Error(`invalid update line in ${operation.path}`);
          }
          hunk.lines.push({
            kind: marker === " " ? "context" : marker === "+" ? "add" : "delete",
            text: line.slice(1),
          });
        }
        if (hunk.lines.length === 0) throw new Error(`empty update hunk: ${operation.path}`);
        operation.hunks.push(hunk);
      }
      if (operation.hunks.length === 0) throw new Error(`update has no hunks: ${operation.path}`);
      operations.push(operation);
      continue;
    }
    throw new Error(`unknown patch operation: ${header ?? "end of input"}`);
  }
  if (operations.length === 0) throw new Error("patch has no operations");
  return operations;
}

// Matching context, ambiguity, insertions, and trailing newlines are separate patch cases.
// eslint-disable-next-line complexity
function replaceHunks(content: string, operation: UpdateOperation): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith("\n");
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  if (trailingNewline) lines.pop();
  let searchFrom = 0;
  for (const hunk of operation.hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== "delete").map((line) => line.text);
    if (oldLines.length === 0) {
      lines.splice(searchFrom, 0, ...newLines);
      searchFrom += newLines.length;
      continue;
    }
    let found = -1;
    for (let candidate = searchFrom; candidate <= lines.length - oldLines.length; candidate += 1) {
      if (oldLines.every((line, offset) => lines[candidate + offset] === line)) {
        if (found !== -1) throw new Error(`patch context is not unique in ${operation.path}`);
        found = candidate;
      }
    }
    if (found === -1) throw new Error(`patch context was not found in ${operation.path}`);
    lines.splice(found, oldLines.length, ...newLines);
    searchFrom = found + newLines.length;
  }
  const result = lines.join(lineEnding);
  return trailingNewline ? `${result}${lineEnding}` : result;
}

type Snapshot = { path: string; existed: boolean; content?: Buffer; mode?: number };

export async function applyPatch(workspace: WorkspaceSandbox, source: string): Promise<string> {
  const operations = parseApplyPatch(source);
  // Applying and rolling back every operation is one serialized workspace transaction.
  // eslint-disable-next-line complexity
  return workspace.mutate(async () => {
    const paths = new Set<string>();
    for (const operation of operations) {
      paths.add(operation.path);
      if (operation.type === "update" && operation.moveTo !== undefined)
        paths.add(operation.moveTo);
    }
    const createdParents = new Set<string>();
    for (const path of paths) {
      workspace.resolve(path, { write: true });
      let parent = dirname(path);
      while (parent !== "." && parent !== "/" && !workspace.exists(parent)) {
        createdParents.add(parent);
        parent = dirname(parent);
      }
    }
    const snapshots: Snapshot[] = [...paths].map((path) => {
      const existed = workspace.exists(path);
      return {
        path,
        existed,
        ...(existed
          ? {
              content: workspace.readFile(path),
              mode: workspace.stat(path).mode & 0o777,
            }
          : {}),
      };
    });
    const changed: string[] = [];
    try {
      for (const operation of operations) {
        if (operation.type === "add") {
          if (workspace.exists(operation.path)) {
            throw new Error(`file already exists: ${operation.path}`);
          }
          await workspace.writeFile(operation.path, operation.content);
          changed.push(`A ${operation.path}`);
        } else if (operation.type === "delete") {
          if (!workspace.exists(operation.path)) {
            throw new Error(`file does not exist: ${operation.path}`);
          }
          await workspace.remove(operation.path);
          changed.push(`D ${operation.path}`);
        } else {
          if (!workspace.exists(operation.path)) {
            throw new Error(`file does not exist: ${operation.path}`);
          }
          const updated = replaceHunks(
            workspace.readFile(operation.path).toString("utf8"),
            operation,
          );
          await workspace.writeFile(operation.path, updated);
          if (operation.moveTo !== undefined) {
            if (workspace.exists(operation.moveTo)) {
              throw new Error(`move target exists: ${operation.moveTo}`);
            }
            await workspace.move(operation.path, operation.moveTo);
            changed.push(`M ${operation.path} -> ${operation.moveTo}`);
          } else {
            changed.push(`U ${operation.path}`);
          }
        }
      }
      return `Done!\n${changed.join("\n")}`;
    } catch (error) {
      for (const snapshot of snapshots.reverse()) {
        if (snapshot.existed && snapshot.content !== undefined) {
          await workspace.writeFile(snapshot.path, snapshot.content);
          if (snapshot.mode !== undefined) await workspace.chmod(snapshot.path, snapshot.mode);
        } else if (workspace.exists(snapshot.path)) {
          await workspace.remove(snapshot.path, true);
        }
      }
      const deepestParents = [...createdParents].sort(
        (left, right) => right.split(/[\\/]/u).length - left.split(/[\\/]/u).length,
      );
      for (const parent of deepestParents) {
        if (workspace.exists(parent)) await workspace.remove(parent);
      }
      throw error;
    }
  });
}
