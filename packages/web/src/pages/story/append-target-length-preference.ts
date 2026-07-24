export type AppendTargetLength = 250 | 500 | 750 | 1000;

export interface AppendTargetLengthOption {
  readonly value: AppendTargetLength;
  readonly label: "短" | "中" | "长" | "很长";
  readonly assistiveText: string;
}

export const DEFAULT_APPEND_TARGET_LENGTH: AppendTargetLength = 1000;

export const APPEND_TARGET_LENGTH_OPTIONS = [
  {
    value: 250,
    label: "短",
    assistiveText: "短，目标约 250 字",
  },
  {
    value: 500,
    label: "中",
    assistiveText: "中，目标约 500 字",
  },
  {
    value: 750,
    label: "长",
    assistiveText: "长，目标约 750 字",
  },
  {
    value: 1000,
    label: "很长",
    assistiveText: "很长，目标约 1000 字",
  },
] as const satisfies readonly AppendTargetLengthOption[];

const APPEND_TARGET_LENGTH_STORAGE_KEY_PREFIX =
  "kimiko.story.append-target-length";

export function readAppendTargetLengthPreference(
  userId: string | null,
): AppendTargetLength {
  if (userId === null) {
    return DEFAULT_APPEND_TARGET_LENGTH;
  }

  try {
    const rawValue = localStorage.getItem(
      getAppendTargetLengthStorageKey(userId),
    );
    if (rawValue === null) {
      return DEFAULT_APPEND_TARGET_LENGTH;
    }

    const parsedValue = Number(rawValue);
    if (isAppendTargetLength(parsedValue)) {
      return parsedValue;
    }

    writeAppendTargetLengthPreference(userId, DEFAULT_APPEND_TARGET_LENGTH);
    return DEFAULT_APPEND_TARGET_LENGTH;
  } catch {
    return DEFAULT_APPEND_TARGET_LENGTH;
  }
}

export function writeAppendTargetLengthPreference(
  userId: string | null,
  value: AppendTargetLength,
): void {
  if (userId === null) {
    return;
  }

  try {
    localStorage.setItem(
      getAppendTargetLengthStorageKey(userId),
      String(value),
    );
  } catch {
    // Ignore local storage failures and keep the in-memory selection.
  }
}

function getAppendTargetLengthStorageKey(userId: string): string {
  return `${APPEND_TARGET_LENGTH_STORAGE_KEY_PREFIX}:${userId}`;
}

function isAppendTargetLength(value: unknown): value is AppendTargetLength {
  return value === 250 || value === 500 || value === 750 || value === 1000;
}
