import { ConfigError } from './client.mjs';
import { BACKGROUND_GROUPS, BACKGROUND_GROUP_KEYS, normalizeBackgroundGroup, UNKNOWN_SCENE } from './scene.mjs';
import { toImageUrl, VisionError } from './vision.mjs';

const ENDPOINT = 'https://api.x.ai/v1/responses';
const DEFAULT_MODEL = 'grok-4.7';
const DEFAULT_TIMEOUT_MS = 20_000;

const FORMAT = {
  type: 'json_schema',
  name: 'reference_background',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      group: { type: 'string', enum: [...BACKGROUND_GROUP_KEYS, UNKNOWN_SCENE] },
      background: { type: 'string', maxLength: 120 },
    },
    required: ['group', 'background'],
  },
};

function responseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  return (payload?.output ?? []).flatMap(item => item?.content ?? [])
    .filter(item => item?.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text).join('\n');
}

function cleanProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new VisionError('unreadable', 'Grok returned no background profile.');
  }
  const group = normalizeBackgroundGroup(profile.group);
  const background = typeof profile.background === 'string'
    ? profile.background.replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';
  return { group, tags: BACKGROUND_GROUPS[group]?.tags ?? [], background };
}

/**
 * Build an injectable reference-only Grok classifier compatible with
 * matchReferencePhoto's compare callback.
 */
export function createGrokBackgroundClassifier({
  apiKey = process.env.XAI_API_KEY,
  model = process.env.XAI_BACKGROUND_MODEL || DEFAULT_MODEL,
  timeoutMs = Number(process.env.XAI_BACKGROUND_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function classifyReferenceBackground({ reference, signal } = {}) {
    if (!apiKey) throw new ConfigError('XAI_API_KEY is not configured.');

    const imageUrl = toImageUrl(reference);
    const imageMime = /^data:([^;,]+)/.exec(imageUrl)?.[1]?.toLowerCase();
    if (!['image/jpeg', 'image/png'].includes(imageMime)) {
      throw new VisionError('bad_image', 'Use a JPEG or PNG reference photo for background matching.');
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          store: false,
          reasoning: { effort: 'low' },
          input: [{
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Inspect only the background of this reference photo. Ignore the person, clothing, pets, and foreground. Classify it into exactly one of these fixed groups:\n${BACKGROUND_GROUP_KEYS.map(key => `- ${key}: ${BACKGROUND_GROUPS[key].look}`).join('\n')}\nIf none clearly fits, choose "${UNKNOWN_SCENE}". Give a short factual description of the visible background (at most eight words). Do not infer a city, landmark, or location that cannot be read from the image.`,
              },
              { type: 'input_image', image_url: imageUrl, detail: 'high' },
            ],
          }],
          text: { format: FORMAT },
        }),
        signal: abort,
      });
    } catch (error) {
      const why = error?.name === 'TimeoutError' || timeout.aborted
        ? `no answer in ${timeoutMs} ms`
        : error.message;
      throw new VisionError('unavailable', `Grok did not answer: ${why}`, { cause: error });
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.error?.message === 'string'
        ? payload.error.message
        : response.statusText;
      if (response.status === 401 || response.status === 403) {
        throw new ConfigError(`Grok rejected the configured API key (HTTP ${response.status}).`);
      }
      throw new VisionError('unavailable', `Grok returned HTTP ${response.status}: ${message.slice(0, 160)}`);
    }

    let profile;
    try {
      profile = cleanProfile(JSON.parse(responseText(payload)));
    } catch (error) {
      if (error instanceof VisionError) throw error;
      throw new VisionError('unreadable', 'Grok returned an unreadable background profile.', { cause: error });
    }

    if (profile.group === UNKNOWN_SCENE || !profile.background) {
      throw new VisionError('unreadable', 'Grok could not identify a clear reference background.');
    }

    return { reference: profile };
  };
}

export { DEFAULT_MODEL as DEFAULT_GROK_BACKGROUND_MODEL, ENDPOINT as GROK_BACKGROUND_ENDPOINT, FORMAT as GROK_BACKGROUND_RESPONSE_FORMAT };
