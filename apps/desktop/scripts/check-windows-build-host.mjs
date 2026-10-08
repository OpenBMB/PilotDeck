const expectedArch = process.argv[2] || process.arch;
if (process.platform !== 'win32' || !['x64', 'arm64'].includes(expectedArch) || process.arch !== expectedArch) {
  throw new Error(`Windows ${expectedArch} packages require a native Windows ${expectedArch} Node.js host; got ${process.platform}/${process.arch}`);
}
console.log(`Verified native Windows ${expectedArch} build host`);
