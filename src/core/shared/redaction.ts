/**
 * Secret redaction.
 *
 * Applied at the log boundary — once, in the sink — rather than at each call site.
 * An adapter that forgets to redact is the normal failure mode, and there are a
 * dozen places that write log lines; there is one place that stores them.
 *
 * Two mechanisms, because either alone leaks. **Known values** catch the secrets the
 * platform resolved itself and can therefore match exactly. **Patterns** catch the
 * ones it never saw: a token a build script printed, a `docker inspect` dump echoing
 * an env var, a private key in a stack trace.
 *
 * The governing rule is that a partial redaction is a leak. Where the extent of a
 * secret is ambiguous — an unquoted value that may or may not contain spaces — this
 * module redacts to the next structural delimiter rather than to the next space, and
 * accepts over-redacting a few harmless characters as the cost. A log line with one
 * word too many removed is a cosmetic problem; a log line with one word of a password
 * left in is an incident.
 */

/** Substituted for every secret. Callers may match on it to assert redaction. */
export const REDACTED = "[REDACTED]";

/**
 * Below this length a "secret" is more likely to be a substring of ordinary text
 * than a credential, and replacing it would corrupt logs without protecting
 * anything.
 */
const MIN_SECRET_LENGTH = 6;

/**
 * Key names that introduce a credential. Applied case-insensitively and without a
 * leading word boundary, so `DB_PASSWORD` and `X-Auth-Token` both match — the prefix
 * is left intact and only the value is replaced.
 */
const SECRET_KEY = String.raw`(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth(?:orization)?)`;

/** Written as an escape so no literal backtick appears inside a pattern source. */
const QUOTE = String.raw`["'\u0060]`;

/**
 * Characters that end an unquoted value: separators between assignments, JSON and
 * shell structure, and line breaks. Brackets are included so an already-redacted
 * `[REDACTED]` is not matched a second time, which keeps redaction idempotent.
 */
const VALUE_END = String.raw`,;&\n\r{}\[\]()`;

/** Key, optional closing quote (JSON keys are quoted), separator, and padding. */
const ASSIGNMENT = String.raw`${SECRET_KEY}["']?[ \t]*[:=][ \t]*`;

/**
 * The first character of an unquoted value. Excludes whitespace and quotes as well as
 * the terminators: a value may not *begin* with a space, or the rule would match the
 * padding in front of an already-inserted marker and redact it a second time.
 */
const VALUE_START = String.raw`[^${VALUE_END}\s'"\u0060]`;

export interface RedactionRule {
  /** Identifies the rule in tests and when explaining a redaction. */
  readonly name: string;
  readonly pattern: RegExp;
  /** May reference capture groups to preserve the non-secret part of a match. */
  readonly replacement: string;
}

/**
 * Shapes worth catching by structure. Ordered most specific first: a PEM block is
 * removed whole before any narrower rule can match a fragment of it, and a quoted
 * assignment is handled before the unquoted rule reaches its opening quote.
 */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = Object.freeze([
  {
    name: "pem-private-key",
    pattern: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  {
    // `https://user:secret@host/path`.
    //
    // The scheme is length-bounded, and that bound is load-bearing: `[a-z0-9+.-]*`
    // unbounded is quadratic on a long line, because it consumes far, fails to find
    // `://`, and backtracks — from every start position. This module runs over
    // untrusted build output where a 40,000-character minified line is routine, so a
    // quadratic scan is a CPU sink in the log path. No real scheme exceeds 31
    // characters.
    //
    // The credential segments stay unbounded on purpose: each excludes its own
    // terminator (`:` and `@`), so there is exactly one way to match and no
    // backtracking to pay for — and bounding them would silently miss a very long
    // credential, which is worse than the cost it would save.
    name: "url-credentials",
    pattern: /([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    replacement: `$1$2:${REDACTED}@`,
  },
  {
    // `password="two words"`, `'two words'`, and the JSON form `"password": "...".`
    // The value may contain anything but its own closing quote and a line break, so a
    // multi-word or punctuation-heavy secret is covered whole.
    name: "quoted-assignment",
    pattern: new RegExp(String.raw`(${ASSIGNMENT})(${QUOTE})(?:(?!\2)[^\n\r])*\2`, "gi"),
    replacement: `$1$2${REDACTED}$2`,
  },
  {
    // `token: abc def`, `DB_PASSWORD=hunter2`, `?password=x&user=y`, and a value whose
    // opening quote is never closed. Runs to the next structural delimiter, never to
    // the next space.
    name: "unquoted-assignment",
    pattern: new RegExp(String.raw`(${ASSIGNMENT})${QUOTE}?${VALUE_START}[^${VALUE_END}]*`, "gi"),
    replacement: `$1${REDACTED}`,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED,
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    replacement: REDACTED,
  },
  {
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED,
  },
  {
    name: "slack-token",
    pattern: /\bxox[abpsr]-[A-Za-z0-9-]{10,}/g,
    replacement: REDACTED,
  },
]);

/**
 * A redactor bound to a specific set of known secret values.
 *
 * Immutable and reusable: build one per deployment from the secrets that were
 * resolved for it, and hand it to the log sink.
 */
export class Redactor {
  private constructor(
    /** Sorted longest first, so a secret containing another is replaced whole. */
    private readonly secrets: readonly string[],
  ) {}

  static create(secrets: readonly string[] = []): Redactor {
    const usable = [...new Set(secrets.filter((s) => s.trim().length >= MIN_SECRET_LENGTH))].sort(
      (a, b) => b.length - a.length,
    );
    return new Redactor(Object.freeze(usable));
  }

  /**
   * Redact a string. Never throws and never returns a non-string: a log line that
   * cannot be redacted must not be emitted, and a redactor that can throw would make
   * failing to log a way to fail a deployment.
   *
   * Patterns run before known values so that no pattern can match, and mangle, a
   * marker this method has already inserted.
   */
  redact(text: string): string {
    let output = text;

    for (const rule of DEFAULT_REDACTION_RULES) {
      output = output.replace(rule.pattern, rule.replacement);
    }

    for (const secret of this.secrets) {
      if (output.includes(secret)) {
        output = output.split(secret).join(REDACTED);
      }
    }

    return output;
  }

  /** Stringify an arbitrary value and redact it. For error causes and dumps. */
  redactUnknown(value: unknown): string {
    if (typeof value === "string") {
      return this.redact(value);
    }
    if (value instanceof Error) {
      return this.redact(`${value.name}: ${value.message}`);
    }
    try {
      return this.redact(JSON.stringify(value) ?? String(value));
    } catch {
      return this.redact(String(value));
    }
  }

  /** How many known secret values this redactor is watching for. */
  get knownSecretCount(): number {
    return this.secrets.length;
  }
}

/** Pattern-only redaction, for text with no associated known secrets. */
const PATTERNS_ONLY = Redactor.create();

export function redact(text: string): string {
  return PATTERNS_ONLY.redact(text);
}
