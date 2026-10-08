import { readFileSync } from "node:fs";

const expectedArch = process.argv[2];
const packageType = process.argv[3] || "deb";
if (process.platform !== "linux" || process.arch !== expectedArch) {
  console.error(`Build the Linux ${expectedArch} package on a native Linux ${expectedArch} host.`);
  process.exit(1);
}

const osRelease = readFileSync("/etc/os-release", "utf8");
if (packageType === "rpm") {
  if (!/^ID="?rocky"?$/m.test(osRelease) || !/^VERSION_ID="?9(?:\.[0-9]+)?"?$/m.test(osRelease)) {
    console.error("Build release RPMs on Rocky Linux 9 to preserve the RHEL 9 glibc baseline.");
    process.exit(1);
  }
} else if (packageType !== "deb") {
  console.error(`Unsupported Linux package type: ${packageType}`);
  process.exit(1);
} else if (!/^ID=ubuntu$/m.test(osRelease) || !/^VERSION_ID="?22\.04"?$/m.test(osRelease)) {
  console.error("Build release DEBs on Ubuntu 22.04 LTS to preserve the minimum supported glibc version.");
  process.exit(1);
}
