# M3-T1 day-one recordings

Recorded on 2026-11-19 against `ClarkeYeh/ai-office-spike` by the M3-T1 probes
(G1 to G11). Every object was closed or deleted afterwards. The run id is
normalized to `000000000001`, so branches read `ai-office/t000000000001-<name>`.
Bodies are summarized by the sanitizer; the synthetic bodies are not recoverable
from these files.

Request-side facts that the envelope does not carry:

| File                                                  | Request detail                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `g2-etag.issue-304`                                   | `If-None-Match` set to the weak ETag from `g2-etag.issue-200`    |
| `g2-etag.issue-200-identity`                          | no `Accept-Encoding`; every other request asked for gzip         |
| `g2-etag.list-issues-304`                             | `If-None-Match` set to the ETag from `g2-etag.list-issues-200`   |
| `g2-etag.list-issues-labeled`                         | same ETag as above, after a label was added                      |
| `g2-etag.list-issues-commented`                       | ETag from the labeled response, after a comment was added        |
| `g2-etag.list-pulls-304`, `g2-etag.matching-refs-304` | `If-None-Match` set to the ETag of the first read (not recorded) |
| `g4-merge.stale-sha-409`                              | `sha` set to a commit that is not the head                       |
| `g4-merge.already-merged-200`                         | the same merge request repeated after success                    |
| `g11-merges.merges-again-204`                         | the same merges request repeated                                 |

Observations behind these files are written up in the M3 verification notes
(kept outside the repository). Short version for replay authors:

- A gzip response returns a weak ETag (`W/"..."`); a 304 or an uncompressed
  response returns the same hash without `W/`.
- `x-ratelimit-*` values come from two interleaved counters during the run, so
  they are not monotonic across files.
- Combined status is `pending` when there are no statuses at all.
- An already-merged pull request merges again with 200 and the same `sha`.
- `POST /merges` marks the pull request merged about three seconds later.
