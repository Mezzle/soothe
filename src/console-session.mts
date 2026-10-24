import { ReceivedData } from "./received-data.mts";

type Serial = {
  connect(options: { path: string; baudRate: number }): Promise<void>;
  disconnect(): Promise<void>;
  write(data: string): Promise<void>;
};
type Effects = {
  changed(): void;
  display(data: Uint8Array): void;
  reset(): void;
  notice(message: string): void;
};
type Phase = "disconnected" | "connecting" | "connected" | "disconnecting";

// Native events carry no session identity. SerialSession suppresses old port
// events; this module owns renderer operations and separates native/demo input.
export class ConsoleSession {
  private serial: Serial | undefined;
  private effects: Effects;
  private received = new ReceivedData();
  private generation = 0;
  private mode: "native" | "demo" | undefined;
  private nativeClosed: boolean | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentPhase: Phase = "disconnected";
  private currentPath = "";
  private sent = 0;

  constructor(serial: Serial | undefined, effects: Effects) {
    this.serial = serial;
    this.effects = effects;
  }

  get phase() {
    return this.currentPhase;
  }
  get connected() {
    return this.currentPhase === "connected" || this.currentPhase === "disconnecting";
  }
  get busy() {
    return this.currentPhase === "connecting" || this.currentPhase === "disconnecting";
  }
  get demo() {
    return this.mode === "demo";
  }
  get path() {
    return this.currentPath;
  }
  get rx() {
    return this.received.rx;
  }
  get tx() {
    return this.sent;
  }
  get log() {
    return this.received.log;
  }

  private begin(mode: "native" | "demo", path: string) {
    this.generation++;
    this.mode = mode;
    this.currentPath = path;
    this.nativeClosed = false;
    this.received.reset();
    this.sent = 0;
    this.effects.reset();
  }

  private receive(data: Uint8Array) {
    this.effects.display(this.received.receive(data));
    this.effects.changed();
  }

  private stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.generation++;
    this.mode = undefined;
    this.currentPhase = "disconnected";
  }

  async connect(path: string, baudRate: number) {
    if (this.currentPhase !== "disconnected") {
      return;
    }
    this.begin("native", path);
    this.currentPhase = "connecting";
    this.effects.notice("");
    this.effects.changed();
    try {
      if (!this.serial) {
        throw new Error("Open the desktop app to connect to serial devices.");
      }
      await this.serial.connect({ path, baudRate });
      if (this.nativeClosed) {
        this.stop();
      } else {
        this.currentPhase = "connected";
      }
    } catch (error) {
      this.stop();
      this.effects.notice(String(error));
    } finally {
      this.effects.changed();
    }
  }

  async disconnect() {
    if (this.currentPhase !== "connected") {
      return;
    }
    if (this.demo) {
      this.stop();
      this.effects.notice("");
      this.effects.changed();
      return;
    }
    this.currentPhase = "disconnecting";
    this.effects.notice("");
    this.effects.changed();
    try {
      // A native session reaches connected only after serial.connect succeeds.
      await (this.serial as Serial).disconnect();
      this.stop();
    } catch (error) {
      if (this.nativeClosed) {
        this.stop();
      } else {
        this.currentPhase = "connected";
      }
      this.effects.notice(String(error));
    } finally {
      this.effects.changed();
    }
  }

  async send(data: string) {
    if (this.currentPhase !== "connected") {
      return;
    }
    const generation = this.generation;
    try {
      if (this.demo) {
        this.receive(new TextEncoder().encode(`\r\n\x1b[36m[demo]\x1b[0m received: ${data}\r\n`));
      } else {
        await (this.serial as Serial).write(data);
      }
      if (generation !== this.generation) {
        return;
      }
      this.sent += new TextEncoder().encode(data).length;
      this.effects.changed();
    } catch (error) {
      if (generation === this.generation) {
        this.effects.notice(String(error));
      }
    }
  }

  startDemo() {
    if (this.currentPhase !== "disconnected") {
      return;
    }
    this.begin("demo", "demo://atom • simulated output");
    this.currentPhase = "connected";
    this.effects.notice("Demo mode. This output is simulated; no USB device is connected.");
    this.receive(
      new TextEncoder().encode(
        "\x1b[90mSoothe demo console • simulated M5Stack Atom\x1b[0m\r\n\r\nESP32 boot complete\r\n\x1b[32m[ok]\x1b[0m Serial console ready at 115200 baud\r\n\x1b[32m[ok]\x1b[0m RGB LED initialized\r\n\x1b[36m[info]\x1b[0m Type below, or click the terminal to send input.\r\n\r\n",
      ),
    );
    let tick = 0;
    this.timer = setInterval(() => {
      this.receive(
        new TextEncoder().encode(
          `\x1b[90m${new Date().toLocaleTimeString()}\x1b[0m  heartbeat=${++tick}  status=\x1b[32mready\x1b[0m\r\n`,
        ),
      );
    }, 2500);
  }

  nativeData(data: Uint8Array) {
    if (this.mode === "native") {
      this.receive(data);
    }
  }

  nativeStatus(status: { connected: boolean; error?: string }) {
    if (this.mode !== "native") {
      return;
    }
    this.nativeClosed = !status.connected;
    if (status.error) {
      this.effects.notice(status.error);
    } else if (!status.connected) {
      this.effects.notice("Serial connection closed. Reconnect when your device is ready.");
    }
    if (!status.connected && !this.busy) {
      this.stop();
    }
    this.effects.changed();
  }
}
