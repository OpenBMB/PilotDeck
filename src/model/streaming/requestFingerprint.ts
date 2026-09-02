import { createHash } from "node:crypto";

import type { CanonicalModelRequest } from "../protocol/canonical.js";

export function requestFingerprint(request: CanonicalModelRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
