const MAX = 18_446_744_073_709_551_615n;
export function parseAmount(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    throw new Error("Enter a positive amount with at most six decimals.");
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (units <= 0n || units > MAX / 2n)
    throw new Error("Amount is outside the supported wager range.");
  return units;
}
export function formatAmount(units: bigint): string {
  const tail = (units % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${units / 1_000_000n}${tail ? "." + tail : ""}`;
}
