import type { Interface } from "node:readline";
import { fitLine } from "./text.js";

export interface MenuItem {
  readonly value: string;
  readonly label: string;
}

/** A small transient region beneath readline, with the cursor left in the draft. */
export class InputMenu {
  private items: readonly MenuItem[] = [];
  private selected = 0;
  private reserved = 0;
  private painted = 0;

  constructor(
    private readonly readline: Interface,
    private readonly output: NodeJS.WritableStream & { columns?: number; rows?: number },
  ) {}

  get active(): boolean { return this.items.length > 0; }
  get selection(): string | undefined { return this.items[this.selected]?.value; }

  show(items: readonly MenuItem[], preserveSelection = false): void {
    const previous = this.selection;
    this.clear();
    this.items = items;
    this.selected = preserveSelection ? Math.max(0, items.findIndex((item) => item.value === previous)) : 0;
    if (items.length === 0) return;
    const height = Math.min(items.length, 16, Math.max(0, (this.output.rows ?? 24) - 2));
    if (height === 0) return;
    if (height > this.reserved) {
      const extra = height - this.reserved;
      const column = this.readline.getCursorPos().cols + 1;
      this.output.write("\r\n".repeat(extra) + `\u001b[${extra}A\u001b[${column}G`);
      this.reserved = height;
    }
    const start = Math.max(0, Math.min(this.selected - height + 1, items.length - height));
    const width = Math.max(1, (this.output.columns ?? 80) - 1);
    this.output.write("\u001b7" + this.belowInput());
    for (let index = 0; index < height; index++) {
      const itemIndex = start + index;
      const item = items[itemIndex];
      this.output.write(`\r\u001b[2K${fitLine(`${itemIndex === this.selected ? "❯" : " "} ${item?.label ?? ""}`, width)}`);
      if (index < height - 1) this.output.write("\u001b[1B");
    }
    this.output.write("\u001b8");
    this.painted = height;
  }

  move(delta: number): void {
    if (!this.active) return;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.show(this.items, true);
  }

  clear(): void {
    if (this.painted > 0) {
      this.output.write("\u001b7" + this.belowInput());
      for (let index = 0; index < this.painted; index++) {
        this.output.write("\r\u001b[2K");
        if (index < this.painted - 1) this.output.write("\u001b[1B");
      }
      this.output.write("\u001b8");
    }
    this.painted = 0;
    this.items = [];
  }

  reset(): void {
    this.clear();
    this.reserved = 0;
  }

  private belowInput(): string {
    const columns = Math.max(1, this.output.columns ?? 80);
    const endRow = Math.floor((2 + this.readline.line.length) / columns);
    const distance = Math.max(1, endRow - this.readline.getCursorPos().rows + 1);
    return `\u001b[${distance}B\r`;
  }
}
