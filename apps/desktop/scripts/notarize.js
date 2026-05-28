"use strict";

const path = require("node:path");
const { notarize } = require("@electron/notarize");

const APP_BUNDLE_ID = "cc.pilotdeck.desktop";

module.exports = async function notarizeAfterSign(context) {
  if (process.platform !== "darwin") {
    console.log("[notarize] Skipping: not macOS.");
    return;
  }
  if (process.env.SKIP_NOTARIZE === "1") {
    console.log("[notarize] Skipping: SKIP_NOTARIZE=1.");
    return;
  }

  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") {
    console.log("[notarize] Skipping: electronPlatformName is not darwin.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const apiKeyPath = process.env.APPLE_API_KEY_PATH;
  const apiKeyId = process.env.APPLE_API_KEY_ID;
  const apiIssuer = process.env.APPLE_API_ISSUER;

  const hasApiKey = Boolean(apiKeyPath && apiKeyId);
  const partialApi =
    Boolean(apiKeyPath || apiKeyId || apiIssuer) && !hasApiKey;

  if (partialApi) {
    throw new Error(
      "[notarize] Incomplete API key env: set both APPLE_API_KEY_PATH and APPLE_API_KEY_ID (and APPLE_API_ISSUER for team keys), or omit them to use the keychain profile.",
    );
  }

  /** @type {import('@electron/notarize').NotarizeOptions} */
  const opts = { appPath };

  if (hasApiKey) {
    console.log(
      `[notarize] Using App Store Connect API key (${APP_BUNDLE_ID}): ${appPath}`,
    );
    opts.appleApiKey = path.resolve(apiKeyPath);
    opts.appleApiKeyId = apiKeyId;
    if (apiIssuer) {
      opts.appleApiIssuer = apiIssuer;
    }
  } else {
    const profile = process.env.NOTARIZE_KEYCHAIN_PROFILE || "EdgeClaw";
    console.log(
      `[notarize] Using keychain profile "${profile}" (${APP_BUNDLE_ID}): ${appPath}`,
    );
    opts.keychainProfile = profile;
  }

  await notarize(opts);
  console.log("[notarize] Finished successfully.");
};
