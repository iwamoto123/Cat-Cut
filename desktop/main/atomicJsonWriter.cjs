const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/** Serialize each file independently so a slow older save can never replace a newer edit. */
function createAtomicJsonWriter(io = fs.promises) {
  const writes = new Map();
  return async function writeAtomicJson(filePath, value) {
    const resolved = path.resolve(filePath);
    const previous = writes.get(resolved) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const temporary = `${resolved}.tmp-${process.pid}-${randomUUID()}`;
      await io.mkdir(path.dirname(resolved), { recursive: true });
      try {
        await io.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf-8");
        await io.rename(temporary, resolved);
      } catch (error) {
        await io.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    writes.set(resolved, next);
    try {
      await next;
    } finally {
      if (writes.get(resolved) === next) writes.delete(resolved);
    }
  };
}

module.exports = { createAtomicJsonWriter };
