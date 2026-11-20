type Ratio = { numerator: bigint; denominator: bigint };

const binaryRatio = (value: number): Ratio => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  /* oxlint-disable no-bitwise -- IEEE-754 exponent and significand are binary fields; shifts retain their exact integer value. */
  const exponent = Number((bits >> 52n) & 0x7_ffn);
  const fraction = bits & 0xf_ff_ff_ff_ff_ff_ffn;
  const significand = exponent === 0 ? fraction : fraction | (1n << 52n);
  const power = exponent === 0 ? -1074 : exponent - 1075;
  return power < 0
    ? { numerator: significand, denominator: 1n << BigInt(-power) }
    : { numerator: significand << BigInt(power), denominator: 1n };
  /* oxlint-enable no-bitwise */
};

const lessThanPowerOfTen = ({ numerator, denominator }: Ratio, exponent: number): boolean =>
  exponent < 0 ? numerator * 10n ** BigInt(-exponent) < denominator : numerator < denominator * 10n ** BigInt(exponent);

/** Match the pinned C++ OFF writer's six significant digits with exact nearest-even rounding. */
export const roundClassicOffCoordinate = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new RangeError('Native OFF coordinates must be finite.');
  }
  if (value === 0) {
    return value;
  }
  const magnitude = Math.abs(value);
  const ratio = binaryRatio(magnitude);
  let exponent = Math.floor(Math.log10(magnitude));
  // Log10 can round across a power-of-ten boundary; compare the exact binary value to correct it.
  while (lessThanPowerOfTen(ratio, exponent)) {
    exponent -= 1;
  }
  while (!lessThanPowerOfTen(ratio, exponent + 1)) {
    exponent += 1;
  }
  const decimalPower = exponent - 5;
  const scale = 10n ** BigInt(Math.abs(decimalPower));
  const numerator = decimalPower < 0 ? ratio.numerator * scale : ratio.numerator;
  const denominator = decimalPower < 0 ? ratio.denominator : ratio.denominator * scale;
  const quotient = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  const roundUp = twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n === 1n);
  const rounded = quotient + (roundUp ? 1n : 0n);
  // Parse the exact decimal result once, avoiding another binary rounding from multiplication by a scale.
  return Math.sign(value) * Number(`${rounded}e${decimalPower}`);
};
