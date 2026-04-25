/**
 * AppSync Events publish helper.
 *
 * Uses HTTP POST with API key auth to publish events to AppSync channels.
 * The API key is Base64URL-encoded in the authorization header.
 */

interface PublishOptions {
  /** The channel to publish to, e.g. "admin/SESSION123" */
  channel: string;
  /** The event payload (will be JSON-stringified) */
  events: unknown[];
}

/**
 * Base64URL-encode a string (no padding, URL-safe alphabet).
 */
function base64UrlEncode(input: string): string {
  const base64 = Buffer.from(input).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Publish one or more events to an AppSync Events channel.
 *
 * Uses the HTTP endpoint with API key authorization.
 * The API key is sent as a Base64URL-encoded value in the Authorization header.
 *
 * @param options - Channel and events to publish
 * @throws On non-2xx response from AppSync
 */
export async function publishToChannel(options: PublishOptions): Promise<void> {
  const httpEndpoint = process.env.APPSYNC_HTTP_ENDPOINT;
  const apiKey = process.env.APPSYNC_API_KEY;

  if (!httpEndpoint || !apiKey) {
    throw new Error('Missing APPSYNC_HTTP_ENDPOINT or APPSYNC_API_KEY environment variables');
  }

  const url = `https://${httpEndpoint}/event`;

  const body = JSON.stringify({
    channel: options.channel,
    events: options.events.map((e) => JSON.stringify(e)),
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `AppSync publish failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }
}
