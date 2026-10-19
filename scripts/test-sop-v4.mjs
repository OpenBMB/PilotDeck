import { spawn } from "node:child_process";

if (!process.env.SOP_RUNTIME_PYTHON) throw new Error("Set SOP_RUNTIME_PYTHON to a Python with packages/sop-runtime installed");
const real = process.argv.includes("--real");
if (real && !process.env.SOP_V4_MODEL_CONFIG) throw new Error("--real requires SOP_V4_MODEL_CONFIG (private PilotDeck YAML)");
const env = { ...process.env, PYTHONPATH: "packages/sop-runtime/src", ...(real ? { SOP_V4_REAL: "1" } : {}) };
delete env.NODE_OPTIONS;
async function run(command, args) {
  const child = spawn(command, args, { env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
if (!real) for (const pattern of ["test_execution_v4.py", "test_execution_api_v4.py"]) await run(env.SOP_RUNTIME_PYTHON, ["-m", "unittest", "discover", "-s", "packages/sop-runtime/tests", "-p", pattern, "-v"]);
await run("pnpm", ["exec", "tsx", "--test", ...(real ? ["--test-name-pattern=v4 real Agent"] : []), "tests/sop/sop-v4-execution.spec.ts", ...(!real ? ["tests/sop/sop-v4-host.spec.ts"] : [])]);
