const { spawn } = require('node:child_process');
const options = JSON.parse(process.env.PILOTDECK_BENCHMARK_OPTIONS);
const child = spawn(options.executable, [options.wrapper], { stdio: 'inherit', windowsHide: false });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => process.exit(code ?? 1));
