/**
 * Pre-approved hosts list for `web_fetch`.
 * Hosts on this list bypass the per-domain user-approval prompt because
 * they're hardcoded canonical sources (docs, package registries, etc.).
 *
 * Source-of-truth comparison criteria (W14 in §5.2):
 *   - Hostname equality OR `*.<host>` subdomain match.
 *   - For specific paths (e.g. `vercel.com/docs`), prefix path match in
 *     addition to host match.
 */

type PreapprovedEntry = {
  /** Lowercased hostname (e.g. "github.com"). */
  host: string;
  /** Optional required path prefix (e.g. "/docs"). */
  pathPrefix?: string;
  /** When true, also accept `*.<host>` subdomains. */
  allowSubdomains?: boolean;
};

/**
 * Static list of 167 entries from the legacy file. Maintained in sync via
 * the `behaviour-alignment-checklist W14` test which spot-checks 5 known
 * entries plus 2 known absences.
 */
export const PREAPPROVED_ENTRIES: ReadonlyArray<PreapprovedEntry> = [
  // Documentation & developer references
  { host: "docs.anthropic.com", allowSubdomains: false },
  { host: "anthropic.com", allowSubdomains: false },
  { host: "developer.mozilla.org", allowSubdomains: false },
  { host: "kernel.org", allowSubdomains: true },
  { host: "linux.die.net", allowSubdomains: false },
  { host: "stackoverflow.com", allowSubdomains: false },
  { host: "wikipedia.org", allowSubdomains: true },
  // Package registries
  { host: "npmjs.com", allowSubdomains: true },
  { host: "pypi.org", allowSubdomains: false },
  { host: "rubygems.org", allowSubdomains: false },
  { host: "crates.io", allowSubdomains: false },
  { host: "pkg.go.dev", allowSubdomains: false },
  { host: "packagist.org", allowSubdomains: false },
  { host: "central.sonatype.com", allowSubdomains: false },
  // Source forges
  { host: "github.com", allowSubdomains: false },
  { host: "gitlab.com", allowSubdomains: false },
  { host: "bitbucket.org", allowSubdomains: false },
  { host: "codeberg.org", allowSubdomains: false },
  { host: "sourceforge.net", allowSubdomains: false },
  // Cloud / infra docs
  { host: "aws.amazon.com", allowSubdomains: false, pathPrefix: "/documentation" },
  { host: "docs.aws.amazon.com", allowSubdomains: false },
  { host: "cloud.google.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "learn.microsoft.com", allowSubdomains: false },
  { host: "docs.microsoft.com", allowSubdomains: false },
  { host: "azure.microsoft.com", allowSubdomains: false, pathPrefix: "/en-us/documentation" },
  { host: "vercel.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "netlify.com", allowSubdomains: false, pathPrefix: "/docs" },
  // Container / orchestration
  { host: "kubernetes.io", allowSubdomains: false },
  { host: "docs.docker.com", allowSubdomains: false },
  { host: "helm.sh", allowSubdomains: false },
  { host: "istio.io", allowSubdomains: false },
  // Languages & runtimes
  { host: "nodejs.org", allowSubdomains: true },
  { host: "deno.land", allowSubdomains: false },
  { host: "bun.sh", allowSubdomains: false },
  { host: "python.org", allowSubdomains: true },
  { host: "go.dev", allowSubdomains: false },
  { host: "rust-lang.org", allowSubdomains: true },
  { host: "ruby-lang.org", allowSubdomains: true },
  { host: "ruby-doc.org", allowSubdomains: false },
  { host: "php.net", allowSubdomains: true },
  { host: "swift.org", allowSubdomains: false },
  { host: "kotlinlang.org", allowSubdomains: false },
  { host: "scala-lang.org", allowSubdomains: false },
  { host: "haskell.org", allowSubdomains: true },
  { host: "elixir-lang.org", allowSubdomains: false },
  { host: "dart.dev", allowSubdomains: false },
  { host: "flutter.dev", allowSubdomains: false },
  // Frameworks
  { host: "react.dev", allowSubdomains: false },
  { host: "reactjs.org", allowSubdomains: false },
  { host: "vuejs.org", allowSubdomains: true },
  { host: "angular.io", allowSubdomains: false },
  { host: "angular.dev", allowSubdomains: false },
  { host: "svelte.dev", allowSubdomains: false },
  { host: "kit.svelte.dev", allowSubdomains: false },
  { host: "nextjs.org", allowSubdomains: false },
  { host: "remix.run", allowSubdomains: false },
  { host: "nuxt.com", allowSubdomains: false },
  { host: "nuxtjs.org", allowSubdomains: false },
  { host: "astro.build", allowSubdomains: false },
  { host: "solidjs.com", allowSubdomains: false },
  { host: "qwik.dev", allowSubdomains: false },
  { host: "expressjs.com", allowSubdomains: false },
  { host: "fastify.dev", allowSubdomains: false },
  { host: "nestjs.com", allowSubdomains: false },
  { host: "django-project.com", allowSubdomains: false },
  { host: "djangoproject.com", allowSubdomains: false },
  { host: "flask.palletsprojects.com", allowSubdomains: false },
  { host: "fastapi.tiangolo.com", allowSubdomains: false },
  { host: "rubyonrails.org", allowSubdomains: false },
  { host: "guides.rubyonrails.org", allowSubdomains: false },
  { host: "spring.io", allowSubdomains: false },
  { host: "laravel.com", allowSubdomains: false },
  // Databases
  { host: "postgresql.org", allowSubdomains: true },
  { host: "mysql.com", allowSubdomains: false, pathPrefix: "/doc" },
  { host: "dev.mysql.com", allowSubdomains: false },
  { host: "mariadb.com", allowSubdomains: false, pathPrefix: "/kb" },
  { host: "mariadb.org", allowSubdomains: false, pathPrefix: "/documentation" },
  { host: "sqlite.org", allowSubdomains: false },
  { host: "redis.io", allowSubdomains: false },
  { host: "mongodb.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "docs.mongodb.com", allowSubdomains: false },
  { host: "cassandra.apache.org", allowSubdomains: false },
  { host: "neo4j.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "duckdb.org", allowSubdomains: false },
  { host: "clickhouse.com", allowSubdomains: false, pathPrefix: "/docs" },
  // CI / build
  { host: "docs.github.com", allowSubdomains: false },
  { host: "circleci.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "travis-ci.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "jenkins.io", allowSubdomains: false, pathPrefix: "/doc" },
  // Observability
  { host: "prometheus.io", allowSubdomains: false },
  { host: "grafana.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "elastic.co", allowSubdomains: false, pathPrefix: "/guide" },
  { host: "opentelemetry.io", allowSubdomains: false },
  // Web standards / RFCs
  { host: "w3.org", allowSubdomains: true },
  { host: "rfc-editor.org", allowSubdomains: false },
  { host: "ietf.org", allowSubdomains: true },
  { host: "tools.ietf.org", allowSubdomains: false },
  { host: "datatracker.ietf.org", allowSubdomains: false },
  { host: "tc39.es", allowSubdomains: false },
  // ML / AI
  { host: "huggingface.co", allowSubdomains: false },
  { host: "pytorch.org", allowSubdomains: false },
  { host: "tensorflow.org", allowSubdomains: true },
  { host: "scikit-learn.org", allowSubdomains: false },
  { host: "openai.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "platform.openai.com", allowSubdomains: false },
  // Editors / IDEs
  { host: "code.visualstudio.com", allowSubdomains: false },
  { host: "marketplace.visualstudio.com", allowSubdomains: false },
  { host: "jetbrains.com", allowSubdomains: false, pathPrefix: "/help" },
  { host: "vim.org", allowSubdomains: false },
  { host: "emacs.org", allowSubdomains: false },
  { host: "neovim.io", allowSubdomains: false },
  // OS / shells
  { host: "manpages.debian.org", allowSubdomains: false },
  { host: "manpages.ubuntu.com", allowSubdomains: false },
  { host: "ss64.com", allowSubdomains: false },
  { host: "tldp.org", allowSubdomains: false },
  { host: "linuxfromscratch.org", allowSubdomains: false },
  // Security
  { host: "owasp.org", allowSubdomains: false },
  { host: "cve.mitre.org", allowSubdomains: false },
  { host: "nvd.nist.gov", allowSubdomains: false },
  { host: "cwe.mitre.org", allowSubdomains: false },
  // Browsers
  { host: "chromium.org", allowSubdomains: true },
  { host: "webkit.org", allowSubdomains: false },
  { host: "mozilla.org", allowSubdomains: true },
  // Search / aggregators (read-only docs entry points)
  { host: "caniuse.com", allowSubdomains: false },
  { host: "npmtrends.com", allowSubdomains: false },
  // Misc trustworthy doc hosts
  { host: "readthedocs.io", allowSubdomains: true },
  { host: "readthedocs.org", allowSubdomains: true },
  { host: "gitbook.io", allowSubdomains: true },
  { host: "notion.so", allowSubdomains: false, pathPrefix: "/help" },
  { host: "supabase.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "firebase.google.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "stripe.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "twilio.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "sendgrid.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "auth0.com", allowSubdomains: false, pathPrefix: "/docs" },
  { host: "okta.com", allowSubdomains: false, pathPrefix: "/docs" },
];

/**
 * Returns true if `(hostname, pathname)` matches a preapproved entry.
 * Hostname matching is case-insensitive; path matching is case-sensitive
 * prefix.
 */
export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  const lower = hostname.toLowerCase();
  for (const entry of PREAPPROVED_ENTRIES) {
    const hostMatch =
      lower === entry.host || (entry.allowSubdomains && lower.endsWith(`.${entry.host}`));
    if (!hostMatch) continue;
    if (entry.pathPrefix && !pathname.startsWith(entry.pathPrefix)) continue;
    return true;
  }
  return false;
}

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isPreapprovedHost(parsed.hostname, parsed.pathname);
  } catch {
    return false;
  }
}
