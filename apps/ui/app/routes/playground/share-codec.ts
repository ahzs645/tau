import { base64ToString, stringToBase64 } from 'uint8array-extras';

type PlaygroundShareCodec<Value> = {
  readonly compress: (value: Value) => Promise<string>;
  readonly decompress: (token: string) => Promise<Value>;
  readonly tryDecompress: (token: string, fallback: Value) => Promise<Value>;
};

const tokenVersion = '1';
const rawCodecId = 'raw';

const parseToken = (token: string): { version: string; codecId: string; payload: string } => {
  const normalized = token.trim();
  const firstDot = normalized.indexOf('.');
  const secondDot = normalized.indexOf('.', firstDot + 1);

  if (firstDot <= 0 || secondDot <= firstDot + 1) {
    throw new Error('Encoded playground token is missing a version/codec prefix');
  }

  return {
    version: normalized.slice(0, firstDot),
    codecId: normalized.slice(firstDot + 1, secondDot),
    payload: normalized.slice(secondDot + 1),
  };
};

const encodeJson = (value: unknown): string => {
  return stringToBase64(JSON.stringify(value), { urlSafe: true }).replace(/=+$/, '');
};

const decodeJson = (payload: string): unknown => {
  return JSON.parse(base64ToString(payload));
};

export const createPlaygroundShareCodec = <Value = Record<string, unknown>>(): PlaygroundShareCodec<Value> => {
  const compress = async (value: Value): Promise<string> => {
    return `${tokenVersion}.${rawCodecId}.${encodeJson(value)}`;
  };

  const decompress = async (token: string): Promise<Value> => {
    const { version, codecId, payload } = parseToken(token);
    if (version !== tokenVersion) {
      throw new Error(`Unsupported playground token version ${version}`);
    }
    if (codecId !== rawCodecId) {
      throw new Error(`Unsupported playground token codec ${codecId}`);
    }

    return decodeJson(payload) as Value;
  };

  const tryDecompress = async (token: string, fallback: Value): Promise<Value> => {
    try {
      return await decompress(token);
    } catch {
      return fallback;
    }
  };

  return {
    compress,
    decompress,
    tryDecompress,
  };
};

export const playgroundShareCodec = createPlaygroundShareCodec();
