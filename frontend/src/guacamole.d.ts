/**
 * Minimal typings for guacamole-common-js, which ships no d.ts of its own.
 *
 * The runtime module has exactly one export — `export default Guacamole` — so
 * everything here that is a *type* is exported separately and must be brought
 * in with `import type`, which TypeScript erases. Importing any of these as a
 * value would fail at runtime.
 */
declare module "guacamole-common-js" {
  export interface GuacStatus {
    code: number;
    message?: string;
  }

  export interface MouseState {
    x: number;
    y: number;
    left: boolean;
    middle: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
  }

  export interface GuacDisplay {
    getElement(): HTMLElement;
    getWidth(): number;
    getHeight(): number;
    scale(scale: number): void;
    onresize: ((width: number, height: number) => void) | null;
  }

  export interface GuacInputStream {
    onblob: ((data: string) => void) | null;
    onend: (() => void) | null;
  }

  export interface GuacOutputStream {
    sendEnd(): void;
  }

  export interface GuacTunnel {
    onerror: ((status: GuacStatus) => void) | null;
    onstatechange: ((state: number) => void) | null;
    disconnect(): void;
  }

  export interface GuacClient {
    getDisplay(): GuacDisplay;
    connect(data?: string): void;
    disconnect(): void;
    sendMouseState(state: MouseState): void;
    sendKeyEvent(pressed: number, keysym: number): void;
    sendSize(width: number, height: number): void;
    createClipboardStream(mimetype: string): GuacOutputStream;
    onstatechange: ((state: number) => void) | null;
    onerror: ((status: GuacStatus) => void) | null;
    onclipboard: ((stream: GuacInputStream, mimetype: string) => void) | null;
    onname: ((name: string) => void) | null;
  }

  export interface GuacMouse {
    onmousedown: ((state: MouseState) => void) | null;
    onmouseup: ((state: MouseState) => void) | null;
    onmousemove: ((state: MouseState) => void) | null;
    onmouseout: (() => void) | null;
  }

  export interface GuacKeyboard {
    onkeydown: ((keysym: number) => boolean | void) | null;
    onkeyup: ((keysym: number) => void) | null;
    reset(): void;
    release(keysym: number): void;
  }

  export interface GuacStringReader {
    ontext: ((text: string) => void) | null;
    onend: (() => void) | null;
  }

  export interface GuacStringWriter {
    sendText(text: string): void;
    sendEnd(): void;
  }

  const Guacamole: {
    Client: new (tunnel: GuacTunnel) => GuacClient;
    WebSocketTunnel: new (url: string) => GuacTunnel;
    Mouse: new (element: Element) => GuacMouse;
    Keyboard: new (element: Element | Document) => GuacKeyboard;
    StringReader: new (stream: GuacInputStream) => GuacStringReader;
    StringWriter: new (stream: GuacOutputStream) => GuacStringWriter;
  };

  export default Guacamole;
}
