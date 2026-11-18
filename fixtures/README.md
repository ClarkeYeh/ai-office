# Recorded fixtures

This directory intentionally contains no recordings yet. Only record from the dedicated
public test repository and the explicitly designated run. Never record an unfiltered
Orca inbox or data from personal or unrelated repositories.

Keep raw recordings outside this repository. Sanitize JSON before copying it here:

```sh
pnpm --filter @ai-office/redaction build
scripts/fixtures/sanitize "$RAW_RECORDING" > "$SANITIZED_FIXTURE"
pnpm fixtures:scan
```

Set the output path to a file ending in `*.json` inside this directory.
The sanitizer accepts a filename or stdin and emits JSON to stdout. It masks emails,
provider tokens, private keys, secret fields, high-entropy strings, home usernames,
and recognized hostnames (common public suffixes, local suffixes, URL authorities,
or explicit host fields). Dotted event types and filenames remain intact.
ULIDs, UUIDs, Orca handles and 40/64-hex hashes are preserved except in secret fields.
By default, only URLs under https://github.com/ClarkeYeh/ai-office-spike are preserved.
Set `AIO_FIXTURE_REPO_URLS` to comma-separated HTTPS repository roots to override this
for both sanitizer and scanner (an empty value preserves no URLs);
URL credentials and secret query parameters are removed or masked. Tool inputs/outputs, transcript text, file contents,
command output and body/content/text fields become UTF-8 byte length plus SHA-256.
For fixtures, all body fields are conservatively summarized, including GitHub bodies.
Review the result before committing: heuristics cannot prove provenance or catch every
possible secret. Single-label hosts must use a host/hostname/machine field.

The scanner uses the same rules and rejects raw body fields, malformed JSON, non-JSON
recordings, binary files, symlinks and unsafe filenames. Only README and empty placeholder
files are permitted alongside JSON. It never prints offending data into CI logs.
Redaction can change replay payloads; build adapter tests around the sanitized shape.

The rules live in `packages/redaction`, shared by fixtures and the server redactor.
The package preserves no repository URLs by default; fixture scripts supply the configuration.
`pnpm fixtures:scan` builds the package before scanning, including on a clean checkout.
