/**
 * S10 (§8.2): revision feedback takes only the repository owner's PR review
 * comments; on a public repository anyone can review, so other authors are
 * only counted. Pure; the caller supplies `ScmPort.listReviewComments` output.
 */
export const ownerReviewFeedback = <C extends { author: string }>(
  comments: readonly C[],
  ownerLogin: string,
): { comments: C[]; ignored: number } => {
  const owner = ownerLogin.toLowerCase();
  const accepted = comments.filter((c) => c.author.toLowerCase() === owner);
  return { comments: accepted, ignored: comments.length - accepted.length };
};
