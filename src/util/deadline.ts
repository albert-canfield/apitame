/**
 * Run `work` with a signal that aborts after `ms`, and settle by then, whatever `work` does.
 *
 * `fetch(url, { signal: AbortSignal.timeout(ms) })` is not enough: once the response headers
 * have arrived, nothing may hold the timeout signal strongly, so a garbage collection can drop
 * it and its timer never fires. A server that sends headers and then drips the body would then
 * hold the request, and anything waiting on it, forever. Here a timer holds the controller until
 * `work` settles, the deadline covers everything `work` does with the signal (reading the body
 * included), and the returned promise rejects at the deadline even if `work` ignores the signal.
 */
export async function withDeadline<T>(
  ms: number,
  timedOut: () => Error,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      reject(timedOut());
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } catch (err) {
    // Whichever noticed first, a request cut by the deadline reports the deadline.
    if (controller.signal.aborted) throw timedOut();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
