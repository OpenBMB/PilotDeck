import assert from "node:assert/strict";
import test, { before } from "node:test";
import { classifyBashPermission, isReadOnlyShellCommand } from "../../../src/tool/builtin/bash/permissions.js";
import { preloadBashParser } from "../../../src/tool/builtin/bash/parser.js";

before(async () => {
  await preloadBashParser();
});

function classify(command: string): string {
  return classifyBashPermission(command).type;
}

test("read-only commands pass through", () => {
  for (const command of [
    "ls",
    "pwd",
    "cat README.md",
    "git status",
    "git diff --stat",
    "find . -name '*.ts'",
    "echo hi && pwd",
    "ls | wc -l",
    "(ls; pwd) | wc",
    "ls 2>/dev/null",
    "ls 2>&1",
    "cat < README.md",
    "echo $HOME",
    "echo \"a\\\"b\"",
    "cat <<'EOF'\n$(rm x)\nEOF",
    "powershell -NoProfile -Command Get-ChildItem",
    "sh -c 'exit 1'",
  ]) {
    assert.equal(isReadOnlyShellCommand(command), true, command);
    assert.equal(classify(command), "passthrough", command);
  }
});

test("a newline separates commands like ; does", () => {
  assert.equal(isReadOnlyShellCommand("echo hi\nrm -rf ./src"), false);
  assert.equal(classify("echo hi\nrm -rf ./src"), "ask");
  assert.equal(classify("echo hi\r\ntouch x"), "ask");
  assert.equal(classify("powershell -Command \"Get-Date\nRemove-Item x\""), "ask");
});

test("hard-deny patterns apply to every command, wherever it appears", () => {
  for (const command of [
    "rm -rf /",
    "echo hi\nrm -rf /",
    "echo hi\nsudo shutdown",
    "ls && rm -rf ~",
    "(cd /tmp; rm -rf /etc)",
    "echo \"$(rm -rf /)\"",
    "if true; then\n  reboot\nfi",
    "f() { mkfs.ext4 /dev/sda1; }",
  ]) {
    assert.equal(classify(command), "deny", command);
  }
});

test("dangerous-ask patterns apply after a newline", () => {
  assert.equal(classify("echo hi\nsudo ls"), "ask");
  assert.equal(classify("echo hi\nrm -r ./build"), "ask");
});

test("syntax outside the read-only subset asks", () => {
  for (const command of [
    "echo $(rm x)",
    "echo `rm x`",
    "cat <(rm x)",
    "cat <<EOF\n$(rm x)\nEOF",
    "cat <<<\"$(id)\"",
    "ls > out.txt",
    "echo hi >> out.txt",
    "ls &> out.txt",
    "ls >& out.txt",
    "ls &",
    "FOO=1 ls",
    "GIT_EXTERNAL_DIFF=./x git diff",
    "for f in *; do cat $f; done",
    "$CMD status",
    "git $SUB",
    "find . $ACTION",
    "echo 'unterminated",
    "ls | tee out.txt",
    "find . -delete",
    "git push",
    "git diff --output=x",
    "git -c core.pager=cat log",
  ]) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
    assert.notEqual(classify(command), "passthrough", command);
  }
});

test("hard-deny patterns do not fire on heredoc text", () => {
  assert.equal(classify("cat <<'EOF'\nrm -rf /\nEOF"), "passthrough");
});
