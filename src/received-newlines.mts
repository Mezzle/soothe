/** Display-only newline handling. Keep the original bytes for logs and counters. */
export class ReceivedNewlines {
  private previousWasCR = false;

  transform(data: Uint8Array): Uint8Array {
    const output = new Uint8Array(data.length * 2);
    let length = 0;
    for (const byte of data) {
      // LF advances the terminal row but needs CR to return to column one.
      // Remember CR across reads because USB chunks need not end on a line.
      if (byte === 10 && !this.previousWasCR) {
        output[length++] = 13;
      }
      output[length++] = byte;
      this.previousWasCR = byte === 13;
    }
    return output.subarray(0, length);
  }

  reset(): void {
    this.previousWasCR = false;
  }
}
