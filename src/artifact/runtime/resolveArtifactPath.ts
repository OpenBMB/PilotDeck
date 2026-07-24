import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export async function resolveArtifactPath(workspaceRoot: string, artifactPath: string): Promise<string> {
  if (isAbsolute(artifactPath)) throw new Error("Artifact paths must be workspace-relative.");
  const root = await realpath(workspaceRoot);
  const candidate = resolve(root, artifactPath);
  assertWithin(root, candidate);

  try {
    await lstat(candidate);
    const canonical = await realpath(candidate);
    assertWithin(root, canonical);
    return canonical;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return candidate;
    throw error;
  }
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"))) return;
  throw new Error("Artifact path escapes the workspace root.");
}
