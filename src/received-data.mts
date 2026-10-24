/** Received session state. Display normalization never changes the log or RX count. */
export class ReceivedData {
  private previousWasCR = false;
  private decoder = new TextDecoder();
  private receivedBytes = 0;
  private receivedText = "";

  get rx(): number {
    return this.receivedBytes;
  }

  get log(): string {
    return this.receivedText;
  }

  receive(data: Uint8Array): Uint8Array {
    const output = new Uint8Array(data.length * 2);
    let length = 0;
    for (const byte of data) {
      // USB reads can split CRLF. Only a lone LF needs an added display CR.
      if (byte === 10 && !this.previousWasCR) {
        output[length++] = 13;
      }
      output[length++] = byte;
      this.previousWasCR = byte === 13;
    }
    this.receivedBytes += data.byteLength;
    // Preserve the existing retention limit in UTF-16 code units.
    this.receivedText = (this.receivedText + this.decoder.decode(data, { stream: true })).slice(-4 * 1024 * 1024);
    return output.subarray(0, length);
  }

  reset(): void {
    this.previousWasCR = false;
    this.decoder = new TextDecoder();
    this.receivedBytes = 0;
    this.receivedText = "";
  }
}
