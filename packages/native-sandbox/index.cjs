"use strict";

const { existsSync } = require("node:fs");
const { join } = require("node:path");

const candidates = [
  join(__dirname, `index.${process.platform}-${process.arch}.node`),
  join(__dirname, "index.node"),
];

const target = candidates.find((candidate) => existsSync(candidate));
if (!target) {
  throw new Error(
    `Native sandbox binary not found for ${process.platform}-${process.arch}. ` +
      `Run "pnpm --filter @pilotdeck/native-sandbox run build" to compile it.`,
  );
}

module.exports = require(target);

