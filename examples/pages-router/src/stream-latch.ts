// Lets the e2e suite hold a streamed boundary open for exactly as long as it
// needs, instead of racing a timer.
const latches = new Map<string, { promise: Promise<string>; release: () => void }>();

export function streamLatch(token: string) {
  let latch = latches.get(token);
  if (!latch) {
    let release!: () => void;
    const promise = new Promise<string>((resolve) => {
      release = () => resolve("Slow content");
    });
    latch = { promise, release };
    latches.set(token, latch);
  }
  return latch;
}

export function releaseStreamLatch(token: string): void {
  streamLatch(token).release();
  latches.delete(token);
}
