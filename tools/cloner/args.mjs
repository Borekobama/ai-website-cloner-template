export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { command, _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    // Split on the first "=" only: URLs and selectors may contain more.
    const separator = token.indexOf('=');
    const key = separator === -1 ? token.slice(2) : token.slice(2, separator);
    if (separator !== -1) {
      options[key] = token.slice(separator + 1);
    } else if (rest[index + 1] && !rest[index + 1].startsWith('--')) {
      options[key] = rest[index + 1];
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}
