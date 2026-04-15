export class Counter {
  private value = 0;

  async fetch(): Promise<Response> {
    return Response.json({ value: ++this.value });
  }
}
