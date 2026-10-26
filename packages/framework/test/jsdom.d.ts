// jsdom ships no type declarations; tests that need a document per case (and
// so their own custom element registry) only use its constructor.
declare module "jsdom" {
  export class JSDOM {
    constructor(
      html?: string,
      options?: { pretendToBeVisual?: boolean; runScripts?: "dangerously" | "outside-only" },
    );
    readonly window: Window & typeof globalThis;
  }
}
