// Decode complete, literal shell words for read-only inspection. This is not
// a general shell parser: interpolation, escapes, concatenation, operators and
// redirects remain outside this grammar. Callers still authorize the command
// head, option effects, executable and each path after decoding.
export function literalInspectionWords(command) {
  if (typeof command !== 'string' || !/["']/.test(command)) return null;
  const words = [];
  let cursor = 0;
  while (cursor < command.length) {
    while (command[cursor] === ' ') cursor += 1;
    if (cursor === command.length) break;
    const first = command[cursor];
    const quote = first === "'" || first === '"' ? first : null;
    let value = '';
    if (quote) {
      cursor += 1;
      while (cursor < command.length && command[cursor] !== quote) {
        const char = command[cursor++];
        if (/[\u0000-\u001f\u007f]/u.test(char)) return null;
        // Double quotes still permit shell interpolation/history expansion.
        if (quote === '"' && /[\\$`!]/u.test(char)) return null;
        value += char;
      }
      if (command[cursor++] !== quote) return null;
      if (cursor < command.length && command[cursor] !== ' ') return null;
    } else {
      while (cursor < command.length && command[cursor] !== ' ') {
        const char = command[cursor++];
        if (/["'\\\u0000-\u001f\u007f]/u.test(char)) return null;
        value += char;
      }
    }
    words.push({ value, quoted: quote !== null });
  }
  return words.length > 0 ? words : null;
}

// A single complete quoted directory followed by the existing conditional
// command separator. The remainder is still parsed and authorized separately.
export function literalCdPrefix(command) {
  if (typeof command !== 'string') return null;
  const match = /^ *cd +('[^']*'|"[^"]*") *&& *(.+)$/su.exec(command);
  if (!match) return null;
  const words = literalInspectionWords(`cd ${match[1]}`);
  if (words?.length !== 2 || !words[1].quoted || words[1].value.length === 0) return null;
  return { target: words[1].value, remainder: match[2], quoted: true };
}
