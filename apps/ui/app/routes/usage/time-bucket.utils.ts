import { format } from 'date-fns';

export type TimeBucket = '5m' | '1h' | '6h' | '1d';

/**
 * Get the bucket key for a date based on the time bucket.
 */
export function getBucketKey(date: Date, bucket: TimeBucket): string {
  const isoString = date.toISOString();
  const dateOnly = isoString.split('T')[0] ?? '';
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();

  switch (bucket) {
    case '5m': {
      // Bucket by 5-minute intervals: YYYY-MM-DDTHH:MM
      const minuteBucket = Math.floor(minute / 5) * 5;
      return `${dateOnly}T${hour.toString().padStart(2, '0')}:${minuteBucket.toString().padStart(2, '0')}`;
    }

    case '1h': {
      // Bucket by hour: YYYY-MM-DDTHH
      return `${dateOnly}T${hour.toString().padStart(2, '0')}`;
    }

    case '6h': {
      // Bucket by 6-hour periods: 0-5, 6-11, 12-17, 18-23
      const period = Math.floor(hour / 6) * 6;
      return `${dateOnly}T${period.toString().padStart(2, '0')}`;
    }

    case '1d': {
      return dateOnly;
    }
  }
}

/**
 * Format the label for a bucket key.
 */
export function formatBucketLabel(bucketKey: string, bucket: TimeBucket): string {
  if (bucket === '1d') {
    return format(new Date(bucketKey), 'MMM d');
  }

  if (bucket === '5m') {
    // Format: "MMM d HH:MM"
    const [datePart, timePart] = bucketKey.split('T');
    if (!datePart || !timePart) {
      return bucketKey;
    }

    const date = new Date(datePart);
    return `${format(date, 'MMM d')} ${timePart}`;
  }

  // For hourly buckets, show date and time
  const [datePart, hourPart] = bucketKey.split('T');
  if (!datePart || !hourPart) {
    return bucketKey;
  }

  const date = new Date(datePart);
  const hour = Number.parseInt(hourPart, 10);

  return `${format(date, 'MMM d')} ${hour}:00`;
}

/**
 * Get the bucket interval in milliseconds.
 */
export function getBucketIntervalMs(bucket: TimeBucket): number {
  switch (bucket) {
    case '5m': {
      return 5 * 60 * 1000;
    }

    case '1h': {
      return 60 * 60 * 1000;
    }

    case '6h': {
      return 6 * 60 * 60 * 1000;
    }

    case '1d': {
      return 24 * 60 * 60 * 1000;
    }
  }
}

/**
 * Round a date down to the nearest bucket boundary.
 */
export function roundToBucket(date: Date, bucket: TimeBucket): Date {
  const result = new Date(date);
  result.setUTCSeconds(0, 0);

  switch (bucket) {
    case '5m': {
      const minutes = result.getUTCMinutes();
      result.setUTCMinutes(Math.floor(minutes / 5) * 5);
      break;
    }

    case '1h': {
      result.setUTCMinutes(0);
      break;
    }

    case '6h': {
      result.setUTCMinutes(0);
      const hours = result.getUTCHours();
      result.setUTCHours(Math.floor(hours / 6) * 6);
      break;
    }

    case '1d': {
      result.setUTCMinutes(0);
      result.setUTCHours(0);
      break;
    }
  }

  return result;
}
