// Runs `fn` with the given environment variables set (`undefined` deletes one)
// and puts the previous values back afterwards, also when `fn` throws or
// returns a promise.
export function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = String(value);
    }
  };
  apply(vars);
  let result;
  try {
    result = fn();
  } catch (error) {
    apply(previous);
    throw error;
  }
  if (typeof result?.then === 'function') return result.finally(() => apply(previous));
  apply(previous);
  return result;
}

// `fn` runs with the home directory (HOME and USERPROFILE) pointing at `home`.
export function withHome(home, fn) {
  return withEnv({ HOME: home, USERPROFILE: home }, fn);
}
