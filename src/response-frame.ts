/**
 * Response-frame completion detection for the pure-JavaScript transport.
 *
 * The TCP protocol has no length prefix and several replies carry blank lines
 * inside their bodies, so whether the bytes received so far form the whole
 * frame depends on which command was sent. {@link beginResponseFrame} records
 * that context once per request (command verb, a SEARCH `HIGHLIGHT` clause,
 * the connection's `DEBUG` flag); {@link isResponseComplete} then walks the
 * reply line by line and stops exactly at the frame's last line.
 *
 * Mirrors the C++ client's `protocol_detection.h`; the grammar follows
 * spec/tcp-commands.md sections 8, 10 and 12, with the transport CRLF the
 * server appends to every response body included. An `ERROR` line ends every
 * frame. A bare `\n` is accepted as a line terminator for hand-written test
 * fixtures; the server always sends `\r\n`.
 */

import { isWireWhitespace } from './command-utils.js';

/** One request token as the server tokenizer splits it (spec/tcp-commands.md section 2.1). */
interface RequestToken {
  /** Raw text between the quotes (or the bare token), escapes left undecoded */
  text: string;
  quoted: boolean;
}

/** Commands whose reply grammar cannot be told from the reply's first line alone. */
type FrameCommand = 'other' | 'search' | 'count' | 'configHelp';

/**
 * Per-request framing context plus the parse position inside the reply.
 * Create one with {@link beginResponseFrame} for every request and pass it to
 * each {@link isResponseComplete} call for that request's reply.
 */
export interface ResponseFrameState {
  command: FrameCommand;
  /** The connection had `DEBUG ON` when the command was sent */
  debug: boolean;
  /** A SEARCH carried an unquoted `HIGHLIGHT` clause */
  highlight: boolean;
  /** Offset of the first line not yet consumed */
  lineStart: number;
  /** Offset of the status line; blank lines before it are a prior reply's leftover */
  frameStart: number;
  /** The status line has been consumed */
  headerSeen: boolean;
  /** The next line is body even if empty (bare `+OK`) */
  bodyLinePending: boolean;
  /** Lines are body until one reads exactly `END` */
  untilEndLine: boolean;
  /** Empty lines still to come; the last one ends the frame */
  blankLinesLeft: number;
}

/** Fold ASCII letters to upper case, leaving every other code unit alone. */
function asciiUpper(value: string): string {
  return value.replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

function equalsIgnoreAsciiCase(lhs: string, rhs: string): boolean {
  return lhs.length === rhs.length && asciiUpper(lhs) === asciiUpper(rhs);
}

/**
 * Split a request line the way the server tokenizer does: on ASCII and Unicode
 * whitespace outside quotes, where `"` and `'` open a quoted region that a
 * backslash escape cannot close and opening a quote flushes any pending bare
 * token. Only token boundaries and the quoted flag are recovered.
 */
function tokenizeRequest(command: string): RequestToken[] {
  const tokens: RequestToken[] = [];
  let start = -1;
  const flush = (end: number): void => {
    if (start !== -1) {
      tokens.push({ text: command.slice(start, end), quoted: false });
      start = -1;
    }
  };

  let pos = 0;
  while (pos < command.length) {
    const char = command[pos];
    if (isWireWhitespace(char)) {
      flush(pos);
      pos += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      flush(pos);
      pos += 1;
      const open = pos;
      while (pos < command.length && command[pos] !== char) {
        pos += command[pos] === '\\' ? 2 : 1;
      }
      const close = Math.min(pos, command.length);
      tokens.push({ text: command.slice(open, close), quoted: true });
      pos = close + 1;
      continue;
    }
    if (start === -1) {
      start = pos;
    }
    pos += 1;
  }
  flush(command.length);
  return tokens;
}

/** Decode a request token's escapes the way the server tokenizer does. */
function decodeRequestToken(token: RequestToken): string {
  if (!token.quoted) {
    return token.text;
  }
  const { text } = token;
  let decoded = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\\' || i + 1 >= text.length) {
      decoded += text[i];
      continue;
    }
    i += 1;
    const escaped = text[i];
    if (escaped === 'n') {
      decoded += '\n';
    } else if (escaped === 't') {
      decoded += '\t';
    } else if (escaped === 'r') {
      decoded += '\r';
    } else if (escaped === 'x') {
      const hex = i + 2 < text.length ? text.slice(i + 1, i + 3) : '';
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
      } else {
        decoded += 'x';
      }
    } else {
      decoded += escaped;
    }
  }
  return decoded;
}

/** A clause keyword that ends even a Boolean search text. */
function isNonExpressionClauseKeyword(token: string): boolean {
  return ['FILTER', 'SORT', 'LIMIT', 'OFFSET', 'HIGHLIGHT', 'FUZZY', 'FACET'].some((word) =>
    equalsIgnoreAsciiCase(token, word)
  );
}

/** A non-expression clause keyword, or AND, OR or NOT. */
function isClauseKeyword(token: string): boolean {
  return (
    isNonExpressionClauseKeyword(token) ||
    equalsIgnoreAsciiCase(token, 'AND') ||
    equalsIgnoreAsciiCase(token, 'OR') ||
    equalsIgnoreAsciiCase(token, 'NOT')
  );
}

function parenDelta(text: string): number {
  let delta = 0;
  for (const char of text) {
    if (char === '(') delta += 1;
    else if (char === ')') delta -= 1;
  }
  return delta;
}

/**
 * Find where the server ends a SEARCH's search text. The text is a Boolean
 * expression when it opens with `NOT`, or when a top-level `OR`, or a
 * parenthesized group after a top-level `AND`/`NOT`, comes before the first
 * clause keyword. A Boolean expression ends only at a top-level non-expression
 * clause keyword; a flat one also at `AND`, `OR` or `NOT`. Quoted tokens are
 * never keywords and their parentheses never count.
 *
 * @returns Index of the first token after the search text
 */
function skipSearchText(tokens: RequestToken[], start: number): number {
  let booleanExpression =
    start < tokens.length && !tokens[start].quoted && equalsIgnoreAsciiCase(tokens[start].text, 'NOT');
  let depth = 0;
  let seenOperator = false;
  for (let i = start; i < tokens.length && !booleanExpression; i += 1) {
    const { text } = tokens[i];
    if (tokens[i].quoted) {
      continue;
    }
    if (depth === 0 && seenOperator && text.includes('(')) {
      booleanExpression = true;
    }
    depth += parenDelta(text);
    if (depth === 0 && (isNonExpressionClauseKeyword(text) || equalsIgnoreAsciiCase(text, 'ORDER'))) {
      break;
    }
    if (depth === 0 && equalsIgnoreAsciiCase(text, 'OR')) {
      booleanExpression = true;
    }
    if (depth === 0 && (equalsIgnoreAsciiCase(text, 'AND') || equalsIgnoreAsciiCase(text, 'NOT'))) {
      seenOperator = true;
    }
  }

  depth = 0;
  let pos = start;
  for (; pos < tokens.length; pos += 1) {
    const { text } = tokens[pos];
    if (tokens[pos].quoted) {
      continue;
    }
    depth += parenDelta(text);
    if (depth === 0 && (isNonExpressionClauseKeyword(text) || (!booleanExpression && isClauseKeyword(text)))) {
      break;
    }
  }
  return pos;
}

const FILTER_OPERATORS = ['>=', '<=', '!=', '<>', '=', '>', '<'];

function startsWithOperator(value: string): boolean {
  return value !== '' && '=<>!'.includes(value[0]);
}

/**
 * Skip the operands of a FILTER clause the way the server consumes them: a
 * token holding the operator (`col=value`, or `col=` followed by the value) is
 * one or two tokens; otherwise the clause takes `col op value`.
 *
 * @param pos - Index just after FILTER
 * @returns Index just after the clause's operands
 */
function skipFilterOperands(tokens: RequestToken[], pos: number): number {
  if (pos >= tokens.length) {
    return pos;
  }
  const first = decodeRequestToken(tokens[pos]);
  for (const op of FILTER_OPERATORS) {
    const at = first.indexOf(op);
    if (at === -1) {
      continue;
    }
    const value = first.slice(at + op.length);
    if (at > 0 && value !== '' && !startsWithOperator(value)) {
      return pos + 1;
    }
    if (at > 0 && value === '' && pos + 1 < tokens.length && !startsWithOperator(decodeRequestToken(tokens[pos + 1]))) {
      return pos + 2;
    }
    break;
  }
  return pos + 3;
}

/** Skip the operands of a SORT clause: `[BY] col [ASC|DESC]` or `[BY] ASC|DESC`. */
function skipSortOperands(tokens: RequestToken[], start: number): number {
  const tokenIs = (index: number, word: string): boolean =>
    index < tokens.length && equalsIgnoreAsciiCase(decodeRequestToken(tokens[index]), word);
  const isOrder = (index: number): boolean => tokenIs(index, 'ASC') || tokenIs(index, 'DESC');
  let pos = start;
  if (tokenIs(pos, 'BY')) {
    pos += 1;
  }
  if (isOrder(pos)) {
    return pos + 1;
  }
  pos += 1;
  return isOrder(pos) ? pos + 1 : pos;
}

/**
 * Check whether a SEARCH carries a HIGHLIGHT clause. After the search text each
 * clause consumes its operands, and only an unquoted `HIGHLIGHT` in clause
 * position counts. Requests the server rejects reply with `ERROR`, which ends
 * the frame whatever this returns.
 */
function searchRequestsHighlight(tokens: RequestToken[]): boolean {
  const searchTextStart = 2;
  const keywordAt = (index: number, keyword: string): boolean =>
    index < tokens.length && !tokens[index].quoted && equalsIgnoreAsciiCase(tokens[index].text, keyword);

  let pos = skipSearchText(tokens, searchTextStart);
  while (pos < tokens.length) {
    const clause = pos;
    pos += 1;
    if (keywordAt(clause, 'HIGHLIGHT')) {
      return true;
    }
    if (keywordAt(clause, 'AND')) {
      pos += keywordAt(pos, 'NOT') ? 2 : 1;
    } else if (keywordAt(clause, 'NOT') || keywordAt(clause, 'LIMIT') || keywordAt(clause, 'OFFSET')) {
      pos += 1;
    } else if (keywordAt(clause, 'FILTER')) {
      pos = skipFilterOperands(tokens, pos);
    } else if (keywordAt(clause, 'SORT')) {
      pos = skipSortOperands(tokens, pos);
    } else if (keywordAt(clause, 'FUZZY')) {
      if (pos < tokens.length && !isClauseKeyword(decodeRequestToken(tokens[pos]))) {
        pos += 1;
      }
    } else {
      return false;
    }
  }
  return false;
}

/**
 * Classify a command line the way the server dispatches it, for the places
 * that depend on the verb rather than on a typed request: keywords match
 * case-insensitively and tokens split on any whitespace.
 *
 * @param {string} command - Request line without its CRLF
 * @returns {string[]} Upper-cased leading keywords (at most two)
 */
function commandKeywords(command: string): string[] {
  return tokenizeRequest(command)
    .slice(0, 2)
    .map((token) => asciiUpper(token.text));
}

/** The long-operation deadlines a raw command can be bound by. */
export interface LongOperationTimeouts {
  optimizeTimeout: number;
  dumpLoadTimeout: number;
  dumpVerifyTimeout: number;
}

/**
 * Pick the deadline for a raw command: the long-operation timeouts apply to
 * `OPTIMIZE`, `DUMP LOAD` and `DUMP VERIFY` however the keywords are cased or
 * spaced, as the server dispatches them. Shared by both transports.
 *
 * @param {string} command - Request line without its CRLF
 * @param {LongOperationTimeouts} timeouts - Configured deadlines
 * @returns {number | undefined} The deadline, or undefined for the default
 */
export function longOperationTimeout(command: string, timeouts: LongOperationTimeouts): number | undefined {
  const [verb, subcommand] = commandKeywords(command);
  if (verb === 'OPTIMIZE') {
    return timeouts.optimizeTimeout;
  }
  if (verb === 'DUMP' && subcommand === 'LOAD') {
    return timeouts.dumpLoadTimeout;
  }
  if (verb === 'DUMP' && subcommand === 'VERIFY') {
    return timeouts.dumpVerifyTimeout;
  }
  return undefined;
}

/**
 * Record the framing context of a request before its reply is read.
 *
 * @param {string} command - The request line as sent, without its CRLF
 * @param {boolean} debugMode - Whether the connection has `DEBUG ON`
 * @returns {ResponseFrameState} Fresh frame state for this request
 */
export function beginResponseFrame(command: string, debugMode: boolean): ResponseFrameState {
  const state: ResponseFrameState = {
    command: 'other',
    debug: debugMode,
    highlight: false,
    lineStart: 0,
    frameStart: 0,
    headerSeen: false,
    bodyLinePending: false,
    untilEndLine: false,
    blankLinesLeft: 0
  };
  const tokens = tokenizeRequest(command);
  if (tokens.length === 0) {
    return state;
  }
  const verb = tokens[0].text;
  if (equalsIgnoreAsciiCase(verb, 'SEARCH')) {
    state.command = 'search';
    state.highlight = searchRequestsHighlight(tokens);
  } else if (equalsIgnoreAsciiCase(verb, 'COUNT')) {
    state.command = 'count';
  } else if (
    equalsIgnoreAsciiCase(verb, 'CONFIG') &&
    tokens.length > 1 &&
    equalsIgnoreAsciiCase(tokens[1].text, 'HELP')
  ) {
    state.command = 'configHelp';
  }
  return state;
}

/** `SHOW VARIABLES`'s bare ASCII table border, with no `OK`/`+OK` status prefix. */
const TABLE_BORDER_PREFIX = '+-';

/**
 * Classify the status line and set up the rest of the frame.
 *
 * @returns True when the status line is the whole frame
 */
function consumeResponseHeader(line: string, state: ResponseFrameState): boolean {
  if (line.startsWith('ERROR ')) {
    return true;
  }
  if (
    line === 'OK INFO' ||
    line === 'OK REPLICATION' ||
    line === 'OK CACHE_STATS' ||
    line === 'OK DUMP_STATUS' ||
    line.startsWith('OK DUMP_INFO')
  ) {
    state.untilEndLine = true;
  } else if (line === 'OK SYNC_STATUS') {
    // The body already ends in "END\r\n", so the transport CRLF adds a blank line.
    state.untilEndLine = true;
    state.blankLinesLeft = 1;
  } else if (line.startsWith('OK FACET')) {
    // Rows, a blank line closing the body, then the transport CRLF. Without the
    // distinct-value total the frame ends at the first blank line; a CRLF after
    // it is skipped as the next reply's leading blank line.
    const hasTotal = line.indexOf(' ', 'OK FACET '.length) !== -1;
    state.blankLinesLeft = hasTotal ? 2 : 1;
  } else if (line.startsWith(TABLE_BORDER_PREFIX)) {
    state.blankLinesLeft = 1;
  } else if (line === '+OK' || line === 'OK CONFIG') {
    // CONFIG body: at least one line, which may be empty when CONFIG SHOW
    // renders an empty value. `OK CONFIG` is the pre-`+OK` spelling.
    state.bodyLinePending = true;
    state.blankLinesLeft = state.command === 'configHelp' ? 2 : 1;
  } else if (line.startsWith('+OK')) {
    state.blankLinesLeft = 1;
  } else if (state.command === 'search' && line.startsWith('OK RESULTS ')) {
    // A highlight header carries only the count; primary keys on it mean a plain reply.
    const afterCount = line.slice('OK RESULTS '.length);
    const highlightRows = state.highlight && /^[0-9]*$/.test(afterCount);
    state.blankLinesLeft = (highlightRows ? 1 : 0) + (state.debug ? 2 : 0);
  } else if (state.command === 'count' && line.startsWith('OK COUNT ')) {
    state.blankLinesLeft = state.debug ? 2 : 0;
  }
  return !state.untilEndLine && !state.bodyLinePending && state.blankLinesLeft === 0;
}

/**
 * Check whether the accumulated reply bytes are one complete frame.
 *
 * Call after every chunk with all bytes received so far for the request the
 * state was begun for; already-consumed lines are not rescanned.
 *
 * @param {string} response - Accumulated reply text
 * @param {ResponseFrameState} state - Context from {@link beginResponseFrame}, advanced in place
 * @returns {boolean} True when `response` ends exactly at the end of the frame
 */
export function isResponseComplete(response: string, state: ResponseFrameState): boolean {
  while (true) {
    const newline = response.indexOf('\n', state.lineStart);
    if (newline === -1) {
      return false;
    }
    let line = response.slice(state.lineStart, newline);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    state.lineStart = newline + 1;

    if (!state.headerSeen) {
      // No reply starts with a blank line, so one here is left over from the previous reply.
      if (line === '') {
        state.frameStart = state.lineStart;
        continue;
      }
      state.headerSeen = true;
      if (consumeResponseHeader(line, state)) {
        return true;
      }
      continue;
    }
    if (state.bodyLinePending) {
      state.bodyLinePending = false;
      continue;
    }
    if (state.untilEndLine) {
      if (line === 'END') {
        state.untilEndLine = false;
        if (state.blankLinesLeft === 0) {
          return true;
        }
      }
      continue;
    }
    if (line === '') {
      state.blankLinesLeft -= 1;
      if (state.blankLinesLeft === 0) {
        return true;
      }
    }
  }
}
