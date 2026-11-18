// Gretel stores entity lists as Python repr strings: [{'entity': 'x', 'types': ['email']}].
// That is not JSON, and downloaded data must never be evaluated as code, so this is a small
// strict parser for the only subset we need: lists, dicts and quoted strings.

export type PyValue = string | PyValue[] | { [key: string]: PyValue };

export function parsePyLiteral(source: string): PyValue {
  let pos = 0;

  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at position ${String(pos)}`);
  };
  const skipSpace = () => {
    while (pos < source.length && /\s/.test(source.charAt(pos))) pos++;
  };
  const expect = (char: string) => {
    skipSpace();
    if (source.charAt(pos) !== char) fail(`expected "${char}"`);
    pos++;
  };

  const parseString = (): string => {
    const quote = source.charAt(pos);
    pos++;
    let out = "";
    while (pos < source.length) {
      const char = source.charAt(pos++);
      if (char === quote) return out;
      if (char !== "\\") {
        out += char;
        continue;
      }
      const next = source.charAt(pos++);
      const simple: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        "\\": "\\",
        "'": "'",
        '"': '"',
      };
      const mapped = simple[next];
      if (mapped !== undefined) out += mapped;
      else if (next === "x" || next === "u") {
        const length = next === "x" ? 2 : 4;
        const hex = source.slice(pos, pos + length);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) fail("bad escape");
        out += String.fromCharCode(parseInt(hex, 16));
        pos += length;
      } else fail(`unsupported escape \\${next}`);
    }
    return fail("unterminated string");
  };

  const parseValue = (): PyValue => {
    skipSpace();
    const char = source.charAt(pos);
    if (char === "'" || char === '"') return parseString();
    if (char === "[") {
      pos++;
      const items: PyValue[] = [];
      skipSpace();
      if (source.charAt(pos) === "]") {
        pos++;
        return items;
      }
      for (;;) {
        items.push(parseValue());
        skipSpace();
        if (source.charAt(pos) === "]") {
          pos++;
          return items;
        }
        expect(",");
      }
    }
    if (char === "{") {
      pos++;
      const object: Record<string, PyValue> = Object.create(null) as Record<string, PyValue>;
      skipSpace();
      if (source.charAt(pos) === "}") {
        pos++;
        return object;
      }
      for (;;) {
        skipSpace();
        const quote = source.charAt(pos);
        if (quote !== "'" && quote !== '"') fail("expected a string key");
        const key = parseString();
        expect(":");
        object[key] = parseValue();
        skipSpace();
        if (source.charAt(pos) === "}") {
          pos++;
          return object;
        }
        expect(",");
      }
    }
    return fail(`unexpected character "${char}"`);
  };

  const value = parseValue();
  skipSpace();
  if (pos !== source.length) fail("trailing characters");
  return value;
}
