/** Recognize Blob/File values across DOM realms without relying on `instanceof`. */
export function isBlobLike(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Blob;
  return (
    typeof candidate.size === "number" &&
    typeof candidate.type === "string" &&
    typeof candidate.slice === "function"
  );
}

/** Read Blob/File bytes even when JSDOM owns the value and Node owns `Request`. */
export async function readBlobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }

  if (typeof FileReader === "function") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read Blob/File body"));
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(reader.result));
          return;
        }
        reject(new TypeError("Expected FileReader to produce an ArrayBuffer"));
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  throw new TypeError(
    "Cannot read this Blob/File in the current test environment. " +
      "Provide a standard Blob implementation with arrayBuffer() or FileReader support.",
  );
}
