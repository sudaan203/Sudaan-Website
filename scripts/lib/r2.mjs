/**
 * Talking to R2 over its S3-compatible API, with no SDK.
 *
 * Extracted from `upload-site.mjs` when a second script needed to reach the same
 * bucket. Forty lines of SigV4 copied into a second file is exactly the shape of
 * problem that produced five elevation ramps in this repository — correct at the
 * moment of copying, and wrong the first time the original changes. Anything
 * that signs an R2 request uses this.
 *
 * The alternative is the AWS SDK, which is tens of megabytes for one PUT, and on
 * this machine `node_modules` is already large enough that iCloud evicts it.
 */

import { createHash, createHmac } from "node:crypto";

const REGION = "auto"; // R2 has one region and expects this literal
const SERVICE = "s3";

/**
 * Node's Hash.update() rejects a single call over roughly 2 GiB ("data is too
 * long") — a real limitation, not a guard of ours, and it bit Kiru's 3.76 GB
 * DSM. Feeding it in chunks is well within what update() supports repeatedly.
 */
const HASH_CHUNK = 512 * 1024 * 1024;
export function hashOf(algorithm, data) {
  const hash = createHash(algorithm);
  if (typeof data === "string" || data.length <= HASH_CHUNK) {
    hash.update(data);
    return hash;
  }
  for (let offset = 0; offset < data.length; offset += HASH_CHUNK) {
    hash.update(data.subarray(offset, offset + HASH_CHUNK));
  }
  return hash;
}
const sha256 = (data) => hashOf("sha256", data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

export const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];

/**
 * Credentials from the environment.
 *
 * `required: false` returns blanks instead of throwing, for a dry run that
 * should still say what it would do on a machine with no keys.
 */
export function r2Credentials({ required = true } = {}) {
  const missing = R2_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0 && required) {
    throw new Error(
      `${missing.join(", ")} not set. Cloudflare dashboard -> R2 -> Manage API tokens.`,
    );
  }
  return {
    account: process.env.R2_ACCOUNT_ID ?? "",
    accessKey: process.env.R2_ACCESS_KEY_ID ?? "",
    secretKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET ?? "",
    missing,
  };
}

/**
 * A signer bound to one bucket.
 *
 * The two places SigV4 usually goes wrong are both handled: every path segment
 * is encoded except the slashes, and the payload hash is the hash of the actual
 * body rather than UNSIGNED-PAYLOAD, so a truncated upload fails the signature
 * instead of silently storing a partial object.
 */
export function r2Client({ account, accessKey, secretKey, bucket }) {
  const host = `${account}.r2.cloudflarestorage.com`;

  /**
   * @param {{ method: string, key?: string, body?: Buffer|string,
   *           contentType?: string, query?: Record<string, string|undefined> }} request
   *   `key` omitted addresses the bucket itself, which is what a listing needs.
   */
  function sign({ method, key = "", body, contentType, query }) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? "");

    const segments = key === "" ? [bucket] : [bucket, ...key.split("/")];
    const canonicalUri = "/" + segments.map((s) => encodeURIComponent(s)).join("/");

    // Sorted key=value pairs joined with "&" — required even for a valueless
    // param like "uploads" (multipart initiate), which still needs its "=".
    const canonicalQuery = query
      ? Object.keys(query).sort()
          .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? "")}`)
          .join("&")
      : "";

    const headers = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(contentType ? { "content-type": contentType } : {}),
    };
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${String(headers[h]).trim()}\n`)
      .join("");

    const canonicalRequest = [
      method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

    let signingKey = hmac(`AWS4${secretKey}`, dateStamp);
    signingKey = hmac(signingKey, REGION);
    signingKey = hmac(signingKey, SERVICE);
    signingKey = hmac(signingKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");

    return {
      url: `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
      headers: {
        ...headers,
        Authorization:
          `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    };
  }

  return { sign, host, bucket };
}

/**
 * Every key under a prefix, following continuation tokens.
 *
 * Paged because a listing returns at most 1000 keys and Ektanagar 2's cloud
 * alone is more than that: a single unpaged call would quietly report a
 * fraction of what is there, which for a tool that deletes things is the
 * difference between a clean prune and a half-done one.
 */
export async function listKeys(client, prefix) {
  const keys = [];
  let token = null;
  do {
    const query = { "list-type": "2", "max-keys": "1000", prefix };
    if (token) query["continuation-token"] = token;
    const request = client.sign({ method: "GET", query });
    const response = await fetch(request.url, { headers: request.headers });
    const xml = await response.text();
    if (!response.ok) {
      throw new Error(`listing ${prefix}: ${response.status} ${xml.slice(0, 300)}`);
    }
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      keys.push(m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    }
    const next = xml.match(/<NextContinuationToken>([^<]+)</);
    token = xml.includes("<IsTruncated>true</IsTruncated>") && next ? next[1] : null;
  } while (token);
  return keys;
}

/** Delete one object. Returns true when it is gone. */
export async function deleteKey(client, key) {
  const request = client.sign({ method: "DELETE", key });
  const response = await fetch(request.url, { method: "DELETE", headers: request.headers });
  // S3 returns 204 for a delete, and also for a key that was not there.
  if (response.ok || response.status === 404) return true;
  throw new Error(`deleting ${key}: ${response.status} ${(await response.text()).slice(0, 200)}`);
}
