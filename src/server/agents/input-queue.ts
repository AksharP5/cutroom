export class InputQueue<T> implements AsyncIterableIterator<T> {
  private readonly items: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T) {
    if (this.ended) throw new Error("The agent input stream is closed.");
    const receive = this.waiting.shift();
    if (receive) receive({ done: false, value: item });
    else this.items.push(item);
  }

  close() {
    this.ended = true;
    for (const receive of this.waiting.splice(0))
      receive({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined)
      return Promise.resolve({ done: false, value: item });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}
