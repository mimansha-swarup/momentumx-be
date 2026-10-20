import { isIP } from "net";
import { extractChannelInfo, extractTextFromHTML } from "../utlils/regex.js";
import ExtractRepository from "../repository/extract.repository.js";

// Phase 01 item 8. `getWebsiteContent` fetches a URL the USER supplies and stores
// the result on their record, and it had none of these guards.
//
// Same 8s bound as research.repository.ts — fetch() has no implicit timeout, so a
// stalled connection would hang onboarding and POST /user/refresh-context.
const SCRAPE_TIMEOUT_MS = 8000;

// The extracted text is stored verbatim and nothing downstream capped it: a
// content-heavy marketing site yields hundreds of KB on a document that Phase 02
// wants small. The prompt effectively truncates it anyway, so 20 KB costs nothing
// real. This is the second lock behind the context subcollection, not the first —
// see phase-02.
const MAX_CONTENT_CHARS = 20_000;

// Read at most this much of the body before giving up. Guards the buffer even when
// a server sends no Content-Length (chunked responses).
const MAX_BODY_BYTES = 2_000_000;

// A server-side fetch of a user-supplied URL is an SSRF primitive: left open, a
// link to 169.254.169.254 or an internal host is fetched by our infrastructure and
// its response stored on the user's profile where they can read it back.
//
// Screened by hostname, before the request. A deliberate first cut, NOT a complete
// defence — it does not re-resolve after redirects, and a public hostname whose DNS
// record points at a private address still passes.
// ponytail: hostname-level SSRF screen; if this path ever fetches
// attacker-chosen URLs at scale, resolve DNS and re-check each redirect hop.

// Reserved names that can never be a public site. `.internal` is permanently
// undelegated by ICANN and `.local` is reserved for mDNS by RFC 6762, so neither
// exists in the root zone — blocking them cannot cost a legitimate address.
// `metadata.google.internal` is the cloud metadata server, which is the single
// most valuable target here given where this deploys.
//
// Anchored deliberately: `localhost.com`, `mylocalhost.com` and
// `shop.local.example.com` are ordinary public hostnames and must pass.
const RESERVED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.internal$/i,
  /\.local$/i,
  /\.home\.arpa$/i,
];

// Applied ONLY to real IP literals. These used to run against the hostname
// directly, which blocked ordinary DNS names that merely begin with a digit —
// `0.pool.ntp.org` and `0.gravatar.com` are both real, and both were refused.
const isPrivateIp = (host: string): boolean => {
  if (isIP(host) === 6) {
    const v6 = host.toLowerCase();
    // IPv4-mapped (::ffff:10.0.0.1) — judge the embedded address, not the wrapper.
    // `new URL()` normalises the tail to hex (`::ffff:a00:1`), so decode both forms
    // rather than assuming the dotted-quad the user typed survives.
    if (v6.startsWith("::ffff:")) {
      const tail = v6.slice(7);
      if (isIP(tail) === 4) return isPrivateIp(tail);
      const hex = tail.split(":");
      if (hex.length === 2 && hex.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
        const packed = (parseInt(hex[0], 16) << 16) | parseInt(hex[1], 16);
        const dotted = [24, 16, 8, 0].map((shift) => (packed >>> shift) & 0xff).join(".");
        return isPrivateIp(dotted);
      }
      return true; // unrecognised mapped form — refuse rather than guess
    }
    if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // fe80::/10 link-local
    return false;
  }

  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o))) return false;
  const [a, b] = octets;

  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast + reserved
  );
};

const assertFetchableUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid website URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported URL scheme");
  }

  // URL.hostname keeps the brackets on an IPv6 literal.
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(host) ? isPrivateIp(host) : RESERVED_HOST_PATTERNS.some((p) => p.test(host))) {
    throw new Error("Refusing to fetch a private address");
  }
  return url;
};

// Reads the body incrementally and stops at the cap, so an endless or
// unlabelled response can never be buffered whole. `res.text()` would have
// happily held all of it in memory first.
const readBounded = async (res: Response, maxBytes: number): Promise<string> => {
  if (!res.body) return "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(decoder.decode(value, { stream: false }));
        break; // truncate rather than throw — partial page text is still useful
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return chunks.join("");
};

class ExtractService {
  private repo: ExtractRepository;

  constructor(repo: ExtractRepository) {
    this.repo = repo;
  }

  getWebsiteContent = async (url: string): Promise<string> => {
    const target = assertFetchableUrl(url);

    const res = await fetch(target, {
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
      redirect: "follow",
    });

    // Cheap rejection when the server declares an oversized body up front. The
    // streaming cap below is what actually holds, since Content-Length is
    // optional and can lie.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new Error("Website response too large");
    }

    const html = await readBounded(res, MAX_BODY_BYTES);
    return extractTextFromHTML(html).slice(0, MAX_CONTENT_CHARS);
  };

  retrieveChannelId = async (channelUrl: string) => {
    const info = extractChannelInfo(channelUrl);

    if (!info) throw new Error("Invalid YouTube channel URL");

    if (info.type === "channel") return info.value;

    // Escaped at the point it becomes a URL parameter. Without this the only thing
    // stopping parameter injection is extractChannelInfo's character class happening
    // to exclude & and # — one regex widening away from a forged request.
    // Only the untrusted VALUE is escaped; the `@` stays literal because that is the
    // form YouTube documents for forHandle. Encoding it to %40 would almost certainly
    // still work, but "almost certainly" is not worth it for zero benefit — the
    // injection risk lives entirely in `info.value`.
    const param =
      info.type === "handle"
        ? `forHandle=@${encodeURIComponent(info.value)}`
        : `forUsername=${encodeURIComponent(info.value)}`;

    const channelRes = await this.repo.retrieveChannelId(param);
    const channel = channelRes?.items?.[0];

    return {
      id: channel?.id,
      description: channel?.brandingSettings?.channel?.description,
    };
  };

  getTopTenTitle = async (channelId: string) => {
    return this.repo.getYTChanelTitles(channelId);
  };
}

export default ExtractService;
