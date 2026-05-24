/**
 * Tweet deduplication logic.
 *
 * Extracted so both background.js and tests can use the same code path.
 */

/**
 * Check whether a tweet is new and track it in seenIds.
 *
 * Returns true  → tweet is new, should be enqueued.
 * Returns false → tweet is a duplicate, should be skipped.
 *
 * - Tweets without an id are always new (and not tracked).
 * - Article tweets bypass dedup — they enrich a previously captured stub.
 * - Media-bearing tweets bypass dedup once when a prior capture had no media.
 */
export function dedupTweet(tweet, seenIds, mediaSeenIds = null) {
  const isDup = !!(tweet.id && seenIds.has(tweet.id));
  const isArticle = !!tweet.is_article;
  const hasMedia = tweetHasMedia(tweet);
  const isMediaEnrichment = !!(
    isDup &&
    hasMedia &&
    mediaSeenIds &&
    !mediaSeenIds.has(tweet.id)
  );

  if (isDup && !isArticle && !isMediaEnrichment) {
    return false;
  }

  if (tweet.id) {
    seenIds.add(tweet.id);
    if (hasMedia && mediaSeenIds) mediaSeenIds.add(tweet.id);
  }

  return true;
}

function tweetHasMedia(tweet) {
  return !!(
    Array.isArray(tweet?.media) && tweet.media.length > 0 ||
    Array.isArray(tweet?.article?.media) && tweet.article.media.length > 0
  );
}
