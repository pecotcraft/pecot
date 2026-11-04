export function calculateExpectedClicks(itemCount: number, perPage: number): number {
  if (itemCount <= perPage) {
    return 0;
  }
  return Math.ceil(itemCount / perPage) - 1;
}

export interface ClicksValidationResult {
  valid: boolean;
  messageId: string | null;
  data: Record<string, string | number | undefined>;
}

export function validateClicks({
  actualClicks,
  itemCount,
  perPage,
  sourceProp,
}: {
  actualClicks: number | undefined;
  itemCount: number;
  perPage: number;
  sourceProp: string;
}): ClicksValidationResult {
  const expectedClicks = calculateExpectedClicks(itemCount, perPage);

  if (itemCount <= perPage) {
    if (actualClicks === undefined || actualClicks === 0) {
      return { valid: true, messageId: null, data: {} };
    }
    return {
      valid: false,
      messageId: 'unnecessaryClicks',
      data: { actual: actualClicks, sourceProp, count: itemCount, perPage },
    };
  }

  if (actualClicks === undefined) {
    return {
      valid: false,
      messageId: 'missingClicks',
      data: { expected: expectedClicks, sourceProp, count: itemCount, perPage },
    };
  }

  if (actualClicks !== expectedClicks) {
    return {
      valid: false,
      messageId: 'incorrectClicks',
      data: {
        actual: actualClicks,
        expected: expectedClicks,
        sourceProp,
        count: itemCount,
        perPage,
      },
    };
  }

  return { valid: true, messageId: null, data: {} };
}

export function validateClicksCount({
  actualClicks,
  itemCount,
  sourceProp,
  offset = 0,
}: {
  actualClicks: number | undefined;
  itemCount: number;
  sourceProp: string;
  offset?: number;
}): ClicksValidationResult {
  const expectedClicks = itemCount + offset;

  if (actualClicks === undefined) {
    return {
      valid: false,
      messageId: 'missingClicksCount',
      data: { expected: expectedClicks, sourceProp, count: itemCount },
    };
  }

  if (actualClicks !== expectedClicks) {
    return {
      valid: false,
      messageId: 'incorrectClicksCount',
      data: {
        actual: actualClicks,
        expected: expectedClicks,
        sourceProp,
        count: itemCount,
      },
    };
  }

  return { valid: true, messageId: null, data: {} };
}

export function validateClicksRequired({
  actualClicks,
  matchedProps,
  minClicks = 1,
}: {
  actualClicks: number | undefined;
  matchedProps: string;
  minClicks?: number;
}): ClicksValidationResult {
  if (actualClicks === undefined) {
    return {
      valid: false,
      messageId: 'missingClicksRequired',
      data: { matchedProps, minClicks },
    };
  }

  if (actualClicks < minClicks) {
    return {
      valid: false,
      messageId: 'insufficientClicks',
      data: { actual: actualClicks, matchedProps, minClicks },
    };
  }

  return { valid: true, messageId: null, data: {} };
}
