type Point = { x: number; y: number };

export class MouseMoveQueue {
  private readonly send: (point: Point) => Promise<number>;
  private pending: Point | null = null;
  private outstanding = 0;
  private sent = new Set<number>();
  private generation = 0;

  constructor(send: (point: Point) => Promise<number>) { this.send = send; }

  move(x: number, y: number) {
    this.pending = { x, y };
    this.flush();
  }

  ack(seq: number) {
    if (!this.sent.delete(seq)) return;
    this.outstanding--;
    this.flush();
  }

  cancelPending() { this.pending = null; }

  reset() {
    this.generation++;
    this.pending = null;
    this.outstanding = 0;
    this.sent.clear();
  }

  private flush() {
    if (!this.pending || this.outstanding >= 4) return;
    const point = this.pending;
    const generation = this.generation;
    this.pending = null;
    this.outstanding++;
    void this.send(point).then((seq) => {
      if (generation !== this.generation) return;
      this.sent.add(seq);
      this.flush();
    }, () => {
      if (generation !== this.generation) return;
      this.outstanding--;
      this.pending = null;
    });
  }
}
