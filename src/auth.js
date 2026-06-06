import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

// Hashing both sides to a fixed 32-byte digest lets timingSafeEqual run on
// equal-length buffers regardless of token length, so the comparison leaks
// no timing signal about how many leading bytes matched.
export function bearerMatches(authorizationHeader, expectedToken) {
  if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith('Bearer ')) {
    return false;
  }
  const presented = authorizationHeader.slice(7);
  return timingSafeEqual(sha256(presented), sha256(expectedToken));
}
