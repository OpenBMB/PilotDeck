export function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    if (token.startsWith('--no-')) {
      result[token.slice(5)] = false;
      continue;
    }
    const equal = token.indexOf('=');
    if (equal !== -1) {
      result[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

export function required(args, name) {
  const value = args[name];
  if (value === undefined || value === true || value === '') {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

export function numberArg(args, name, fallback) {
  if (args[name] === undefined) return fallback;
  const value = Number(args[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}
