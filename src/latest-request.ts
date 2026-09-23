/** One response owner per resource. Superseded fetches are aborted and ignored. */
export class LatestRequest {
  private controller: AbortController | null = null;

  start(): AbortSignal {
    this.cancel();
    this.controller = new AbortController();
    return this.controller.signal;
  }

  owns(signal: AbortSignal): boolean {
    return this.controller?.signal === signal && !signal.aborted;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }
}
