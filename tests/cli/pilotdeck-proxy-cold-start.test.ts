import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("server cold start passes configured noProxy to the proxy installer", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pilotdeckSource = await readFile(resolve(here, "../../src/cli/pilotdeck.js"), "utf8");

  assert.match(
    pilotdeckSource,
    /installGlobalProxy\(\s*snapshot\.config\.proxy\.url,\s*snapshot\.config\.proxy\.noProxy\s*\)/,
  );
  assert.doesNotMatch(
    pilotdeckSource,
    /installGlobalProxy\(\s*snapshot\.config\.proxy\.url\s*\)/,
  );
});
