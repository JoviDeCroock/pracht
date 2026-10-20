// Preact runs effects and unmount cleanups after the next paint: a
// requestAnimationFrame raced by a 35 ms timer whose callback calls
// cancelAnimationFrame. A DOM test file that unmounts as it ends tears its
// environment down inside that window under load, and the timer then throws
// "cancelAnimationFrame is not defined" into the next file's run. This keeps
// Preact's scheduling but skips a frame whose environment is gone.
if (typeof window !== "undefined") {
  const { options } = await import("preact");
  options.requestAnimationFrame = (callback: () => void): number => {
    let frame: number | undefined;
    const done = () => {
      clearTimeout(timeout);
      if (typeof cancelAnimationFrame === "function" && frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      if (typeof window !== "undefined") setTimeout(callback);
    };
    const timeout = setTimeout(done, 35);
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(done);
    return 0;
  };
}
