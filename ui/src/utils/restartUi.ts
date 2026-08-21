type RestartSplashCopy = {
  title?: string;
  description?: string;
  documentTitle?: string;
};

type PollHealthOptions = {
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  reload?: () => void;
  setIntervalImpl?: typeof window.setInterval;
  clearIntervalImpl?: typeof window.clearInterval;
};

type RestartAndReloadOptions = PollHealthOptions & {
  copy?: RestartSplashCopy;
};

const DEFAULT_TITLE = "Restarting PilotDeck...";
const DEFAULT_DESCRIPTION = "Page will reload automatically when server is ready.";

export function showRestartSplash(copy: RestartSplashCopy = {}) {
  const title = copy.title ?? DEFAULT_TITLE;
  const description = copy.description ?? DEFAULT_DESCRIPTION;

  document.title = copy.documentTitle ?? title;
  document.body.innerHTML = "";
  document.body.style.cssText =
    "margin:0;background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh";

  const container = document.createElement("div");
  container.style.cssText = "text-align:center;font-family:system-ui,-apple-system,sans-serif";

  const spinner = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  spinner.setAttribute("viewBox", "0 0 24 24");
  spinner.setAttribute("fill", "none");
  spinner.setAttribute("stroke", "#888");
  spinner.setAttribute("stroke-width", "2");
  spinner.style.cssText =
    "width:40px;height:40px;margin-bottom:16px;animation:restart-ui-spin 1s linear infinite";

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M21 12a9 9 0 1 1-6.22-8.56");
  spinner.appendChild(path);

  const titleEl = document.createElement("p");
  titleEl.textContent = title;
  titleEl.style.cssText = "color:#ccc;font-size:1.1rem;margin:0 0 8px";

  const descriptionEl = document.createElement("p");
  descriptionEl.textContent = description;
  descriptionEl.style.cssText = "color:#666;font-size:0.8rem;margin:0";

  const style = document.createElement("style");
  style.textContent = "@keyframes restart-ui-spin{to{transform:rotate(360deg)}}";

  container.append(spinner, titleEl, descriptionEl);
  document.body.append(container, style);
}

export function pollHealthAndReload({
  fetchImpl = fetch,
  intervalMs = 2000,
  reload = () => window.location.reload(),
  setIntervalImpl = window.setInterval,
  clearIntervalImpl = window.clearInterval,
}: PollHealthOptions = {}) {
  const poll = setIntervalImpl(() => {
    void (async () => {
      try {
        const res = await fetchImpl("/health");
        if (res.ok) {
          clearIntervalImpl(poll);
          reload();
        }
      } catch {
        // The server is expected to be unavailable while restarting.
      }
    })();
  }, intervalMs);

  return poll;
}

export function restartAndReload(
  requestRestart: () => Promise<unknown>,
  options: RestartAndReloadOptions = {},
) {
  showRestartSplash(options.copy);
  void requestRestart().catch(() => {
    // The restart request can be interrupted when the server exits.
  });
  return pollHealthAndReload(options);
}
