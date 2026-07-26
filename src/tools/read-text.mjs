import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";

export async function assertTextFile(filePath, { signal } = {}) {
  signal?.throwIfAborted();
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) throw new Error("Binary files are not supported.");
    signal?.throwIfAborted();
  } finally {
    await handle.close();
  }
}

export async function readLineRange(
  filePath,
  { startLine = 1, endLine = startLine + 199, maxOutputBytes = 65536, signal } = {},
) {
  await assertTextFile(filePath, { signal });
  const stream = createReadStream(filePath, { encoding: "utf8", signal });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const selected = [];
  let lineNumber = 0;
  let totalLines = null;
  let bytes = 0;
  let truncated = false;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber < startLine) continue;
      if (lineNumber > endLine) {
        totalLines = lineNumber;
        break;
      }
      const rendered = `${lineNumber}: ${line}`;
      const size = Buffer.byteLength(rendered) + 1;
      if (bytes + size > maxOutputBytes) {
        truncated = true;
        break;
      }
      selected.push(rendered);
      bytes += size;
    }
    if (totalLines === null && !truncated) totalLines = lineNumber;
  } finally {
    lines.close();
    stream.destroy();
  }

  return {
    text: selected.join("\n"),
    startLine,
    requestedEndLine: endLine,
    actualEndLine: selected.length ? startLine + selected.length - 1 : Math.min(lineNumber, endLine),
    totalLines,
    truncated,
    empty: selected.length === 0,
  };
}
