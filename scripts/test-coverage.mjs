import { spawn } from "node:child_process";
import { globSync } from "node:fs";

const args = [
  "--experimental-test-coverage",
  "--test-coverage-lines=20",
  "--test-coverage-functions=15",
  "--test-coverage-branches=10",
  "--test-coverage-include=dist/src/gateway/**/*.js",
  "--test-coverage-include=dist/src/model/protocol/**/*.js",
  "--test-coverage-include=dist/src/model/streaming/**/*.js",
  "--test-force-exit",
  "--test-timeout=60000",
  "--test",
  ...[
    "dist/tests/gateway/*.spec.js",
    "dist/tests/model/request/malformedMessages.spec.js",
    "dist/tests/model/request/openaiReasoningContent.spec.js",
    "dist/tests/model/streaming/*.spec.js",
  ].flatMap(pattern => globSync(pattern)),
];

const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
child.on("exit", code => process.exit(code ?? 1));
child.on("error", error => {
  console.error(error);
  process.exit(1);
});
