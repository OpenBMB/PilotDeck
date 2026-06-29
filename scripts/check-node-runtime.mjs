const minimumNodeVersion = [22, 13, 0];
const minimumNodeVersionLabel = "22.13.0";

function parseNodeVersion(version) {
  return version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isAtLeastMinimum(version) {
  const current = parseNodeVersion(version);
  for (let index = 0; index < minimumNodeVersion.length; index += 1) {
    if ((current[index] ?? 0) > minimumNodeVersion[index]) return true;
    if ((current[index] ?? 0) < minimumNodeVersion[index]) return false;
  }
  return true;
}

function fail(message) {
  console.error(`[pilotdeck] ${message}`);
  process.exit(1);
}

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, typeOrOptions, ...args) => {
  const warningType = typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
  const warningText = typeof warning === "string" ? warning : warning?.message;
  if (warningType === "ExperimentalWarning" && warningText?.includes("SQLite")) {
    return;
  }
  emitWarning(warning, typeOrOptions, ...args);
};

const nodeVersion = process.versions.node;
if (!isAtLeastMinimum(nodeVersion)) {
  fail(
    `Node.js >=${minimumNodeVersionLabel} is required because PilotDeck uses node:sqlite. Current: v${nodeVersion}.`,
  );
}

try {
  await import("node:sqlite");
} catch {
  fail(
    `Current Node.js (v${nodeVersion}) does not provide node:sqlite. Switch to Node.js ${minimumNodeVersionLabel}+ and reinstall dependencies.`,
  );
}
