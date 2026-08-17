import { dirname } from "node:path";

const SKILL_ROOT_SHELL_TOKEN = "{{SKILL_ROOT_SHELL}}";
const ESCAPED_SKILL_ROOT_SHELL_TOKEN = "{{!SKILL_ROOT_SHELL}}";

/** Expand the selected skill's own directory into shell examples safely. */
export function renderSkillContent(content: string, skillFilePath: string): string {
  if (
    !content.includes(SKILL_ROOT_SHELL_TOKEN)
    && !content.includes(ESCAPED_SKILL_ROOT_SHELL_TOKEN)
  ) {
    return content;
  }
  const shellRoot = quotePosixShell(dirname(skillFilePath));
  return content
    .split(ESCAPED_SKILL_ROOT_SHELL_TOKEN)
    .map((segment) => segment.replaceAll(SKILL_ROOT_SHELL_TOKEN, shellRoot))
    .join(SKILL_ROOT_SHELL_TOKEN);
}

function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
