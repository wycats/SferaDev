const PREFIX = "m:";

export function encodeVsCodeModelId(rawModelId: string): string {
  return `${PREFIX}${encodeURIComponent(rawModelId)}`;
}

export function decodeVsCodeModelId(vsCodeModelId: string): string {
  const encoded = vsCodeModelId.startsWith(PREFIX)
    ? vsCodeModelId.slice(PREFIX.length)
    : vsCodeModelId;

  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
