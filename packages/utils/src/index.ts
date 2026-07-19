export interface RandomIntOptions {
  max: number;
  min: number;
}

export function formatDate(date: Date, locale = "zh-CN"): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function randomInt({ max, min }: RandomIntOptions): number {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new TypeError("randomInt requires integer min and max values.");
  }

  if (max < min) {
    throw new RangeError(
      "randomInt requires max to be greater than or equal to min.",
    );
  }

  const span = max - min + 1;
  return Math.floor(Math.random() * span) + min;
}
