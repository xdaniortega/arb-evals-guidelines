/**
 * Runner compatibility shim for owner-authored case validator tests.
 *
 * Case validators and their tests are owner-authored and use TypeScript's `.js`
 * specifier convention with the `node:test` runner. Node's type stripping does not
 * rewrite specifiers, so this hook maps a relative `./x.js` import inside a
 * TypeScript module to a sibling `./x.ts` file when that file exists. It resolves
 * nothing else and never reads, rewrites, or transforms module contents.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (parent?.endsWith(".ts") && specifier.endsWith(".js") && /^\.{1,2}\//.test(specifier)) {
      const rewritten = `${specifier.slice(0, -".js".length)}.ts`;
      const candidate = new URL(rewritten, parent);
      if (candidate.protocol === "file:" && existsSync(fileURLToPath(candidate))) {
        return nextResolve(rewritten, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
