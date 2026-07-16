import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("UI weixin QR route only reads runtime status", () => {
  const source = readFileSync(join(process.cwd(), "ui/server/routes/gateway.js"), "utf8");
  const routeStart = source.indexOf("router.get('/weixin/qr'");
  const routeEnd = source.indexOf("router.post('/weixin/disable'");

  assert.ok(routeStart >= 0, "expected /weixin/qr route to exist");
  assert.ok(routeEnd > routeStart, "expected weixin route section to be bounded");

  const weixinRouteSection = source.slice(routeStart, routeEnd);
  assert.doesNotMatch(weixinRouteSection, /loginWithQR/);
  assert.doesNotMatch(weixinRouteSection, /weixin-ilink/);
  assert.doesNotMatch(weixinRouteSection, /_weixinLogin/);
  assert.match(weixinRouteSection, /runtime\?\.state === 'waiting_for_login' && runtime\.qrUrl/);
});

test("UI weixin QR begin route delegates to gateway prepare RPC", () => {
  const source = readFileSync(join(process.cwd(), "ui/server/routes/gateway.js"), "utf8");
  const routeStart = source.indexOf("router.post('/weixin/qr-begin'");
  const routeEnd = source.indexOf("router.get('/weixin/qr'");

  assert.ok(routeStart >= 0, "expected /weixin/qr-begin route to exist");
  assert.ok(routeEnd > routeStart, "expected begin route to be before read-only QR route");

  const beginRouteSection = source.slice(routeStart, routeEnd);
  assert.match(beginRouteSection, /config\.adapters\.weixin = \{ \.\.\.previous, enabled: true \}/);
  assert.match(beginRouteSection, /gw\.prepareWeixinLogin/);
  assert.match(beginRouteSection, /requestedAt/);
  assert.doesNotMatch(beginRouteSection, /loginWithQR/);
  assert.doesNotMatch(beginRouteSection, /weixin-ilink/);
  assert.doesNotMatch(beginRouteSection, /_weixinLogin/);
});

test("Gateway settings keeps existing status rendered during silent refresh", () => {
  const source = readFileSync(
    join(process.cwd(), "ui/src/components/settings/view/tabs/GatewaySettingsTab.tsx"),
    "utf8",
  );

  assert.match(source, /if \(loading && !status\)/);
  assert.doesNotMatch(source, /if \(loading \|\| !status\)/);
  assert.match(source, /void fetch_\(\{ showLoading: true \}\)/);
  assert.match(source, /setInterval\(\(\) => \{\s*void fetch_\(\);/s);
});

test("Gateway settings starts weixin QR by begin route and ignores stale runtime errors", () => {
  const source = readFileSync(
    join(process.cwd(), "ui/src/components/settings/view/tabs/GatewaySettingsTab.tsx"),
    "utf8",
  );

  assert.match(source, /authenticatedFetch\('\/api\/gateway\/weixin\/qr-begin', \{ method: 'POST' \}\)/);
  assert.doesNotMatch(source, /authenticatedFetch\('\/api\/gateway\/weixin\/qr'\)/);
  assert.match(source, /requestedAtRef/);
  assert.match(source, /isWeixinRuntimeCurrent/);
  assert.match(source, /WEIXIN_QR_PREPARE_TIMEOUT_MS/);
});

test("Gateway protocol exposes prepare_weixin_login RPC", () => {
  const frames = readFileSync(join(process.cwd(), "src/gateway/protocol/frames.ts"), "utf8");
  const wsConnection = readFileSync(join(process.cwd(), "src/gateway/server/GatewayWsConnection.ts"), "utf8");
  const remoteGateway = readFileSync(join(process.cwd(), "src/gateway/client/RemoteGateway.ts"), "utf8");
  const inProcessGateway = readFileSync(join(process.cwd(), "src/gateway/client/InProcessGateway.ts"), "utf8");
  const pilotdeck = readFileSync(join(process.cwd(), "src/cli/pilotdeck.ts"), "utf8");

  assert.match(frames, /"prepare_weixin_login"/);
  assert.match(wsConnection, /case "prepare_weixin_login"/);
  assert.match(remoteGateway, /request\("prepare_weixin_login", \{\}\)/);
  assert.match(inProcessGateway, /prepareWeixinLogin/);
  assert.match(pilotdeck, /setPrepareWeixinLogin/);
  assert.match(pilotdeck, /hotStartWeixinChannel/);
});
