import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Track everything copied into the bundle, including linked public fonts/media.
 * Source/config files use content hashes; public assets use file metadata so a
 * long source video is never read into memory merely to validate the cache.
 */
export function computeBundleCacheKey(remotionRoot: string): string {
  const hash = crypto.createHash("sha1");
  hash.update("catcut-bundle-v2\n");

  const walk = (filePath: string, contents: boolean, ancestors: Set<string>): void => {
    const relative = path.relative(remotionRoot, filePath);
    let entry: fs.BigIntStats;
    try {
      entry = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update(`${relative}|absent\n`);
      return;
    }
    if (entry.isSymbolicLink()) {
      hash.update(`${relative}|link|${fs.readlinkSync(filePath)}\n`);
      try {
        entry = fs.statSync(filePath, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update(`${relative}|dangling\n`);
        return;
      }
    }
    if (entry.isDirectory()) {
      const realPath = fs.realpathSync(filePath);
      if (ancestors.has(realPath)) throw new Error(`Circular bundle input: ${relative}`);
      const nextAncestors = new Set(ancestors).add(realPath);
      hash.update(`${relative}|directory\n`);
      for (const child of fs.readdirSync(filePath).sort()) {
        walk(path.join(filePath, child), contents, nextAncestors);
      }
    } else if (entry.isFile()) {
      hash.update(`${relative}|file|`);
      if (contents) {
        hash.update(fs.readFileSync(filePath));
      } else {
        hash.update(`${entry.size}|${entry.mtimeNs}|${entry.ctimeNs}`);
      }
      hash.update("\n");
    }
  };

  walk(path.join(remotionRoot, "src"), true, new Set());
  walk(path.join(remotionRoot, "public"), false, new Set());
  for (const config of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "tsconfig.json", "remotion.config.ts"]) {
    walk(path.join(remotionRoot, config), true, new Set());
  }
  return hash.digest("hex");
}
