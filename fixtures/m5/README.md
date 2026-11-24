# M5 event exports

Public exports use this JSON envelope:

```json
{
  "exportedAt": "2000-01-01T00:00:00.000Z",
  "aiOfficeCommit": "0000000000000000000000000000000000000000",
  "orcaVersion": "1.4.272",
  "events": []
}
```

Use exportJointEvents in apps/server/src/test-support/joint/export/index.ts.
The helper retains numeric and boolean facts and explicitly allowed string paths
per event type. Other strings become deterministic placeholders:
`‹text len=<UTF-16 length> sha=<first 12 SHA-256 hex digits>›`.
Times are shifted relative to the first event, preserving intervals.
Unknown event types retain no string fields except their placeholder.
Only exact, caller-reviewed requirement strings may be preserved.
Never approve agent text as requirements.

Raw exports stay in a private local directory with mode 0600; never commit them.
Do not include credentials, control tokens, email, transcript, or agent prose.
The scanner rejects non-placeholder natural-language JSON strings over 80 characters.
The final public joint.events.json is produced by T12; no live data is included here.
